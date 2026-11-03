import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { basesPolicyFixture, basesCliFixture } from "../../../../tests/review/bases-policy-fixture";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import { basesCallerForPagesViewer, basesCallerFromCliAuth, basesCallerFromConsoleWorkspace, basesSystemCaller, type BasesCaller } from "./context";
import {
  chartDataForCaller,
  createRowThroughViewForCaller,
  describeViewForCaller,
  queryViewForCaller,
  updateRowThroughViewForCaller,
} from "./for-caller";
import { handleBasesRequest } from "./http";

// Integration tests through `handleBasesRequest`, one block per CHECKS.md
// section. Runs only with BASES_TEST_DATABASE_URL (and DATABASE_URL) pointing
// at a migrated Console database. Creates its own organization, users,
// projects, Pages site, and installation, and deletes them afterwards.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "developer" | "viewer" | "billing" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectA = { id: randomUUID(), slug: `bases-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `bases-b-${suffix}` };
const siteA = randomUUID();
const siteB = randomUUID();
const installationId = randomUUID();
const revokedInstallationId = randomUUID();

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `bases-svc-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const viewer = makeUser("viewer", "viewer"); // project viewer
const projDev = makeUser("projdev", "viewer"); // project developer
const billing = makeUser("billing", "billing"); // project viewer
const outsider = makeUser("outsider", "viewer"); // no project membership
const USERS = [owner, dev, viewer, projDev, billing, outsider];
let cliSession: Awaited<ReturnType<typeof basesCliFixture>>;

function consoleCaller(user: TestUser, organizationId = orgId): BasesCaller {
  return basesCallerFromConsoleWorkspace(
    {
      mode: "workos",
      user: { id: user.id, primaryEmail: user.email },
      organization: { id: organizationId },
      membership: { role: user.orgRole },
    } as unknown as Parameters<typeof basesCallerFromConsoleWorkspace>[0],
    randomUUID(),
  );
}

function cliCaller(user: TestUser, installation = installationId, hint?: unknown): BasesCaller {
  return basesCallerFromCliAuth(
    {
      user: { id: user.id, primaryEmail: user.email },
      organization: { id: orgId },
      membership: { role: user.orgRole },
      localInstallation: { id: installation },
      ...cliSession(user.id),
    } as unknown as Parameters<typeof basesCallerFromCliAuth>[0],
    randomUUID(),
    hint,
  );
}

function pageCaller(user: TestUser, siteId: string): BasesCaller {
  return basesCallerForPagesViewer({
    organizationId: orgId,
    userId: user.id,
    email: user.email,
    pagesSessionId: `ps_${suffix}`,
    siteId,
    orgRole: user.orgRole,
    requestId: randomUUID(),
  });
}

let keySeq = 0;
const idem = (label = "op") => `${label}-${suffix}-${(keySeq += 1)}`;

async function call(
  caller: BasesCaller,
  method: string,
  path: string,
  body: unknown = {},
  options: { project?: string; query?: string; idempotencyKey?: string; workspace?: Parameters<typeof handleBasesRequest>[0]["workspace"] } = {},
): Promise<Res> {
  try {
    const result = await handleBasesRequest({
      caller,
      workspace: options.workspace ?? null,
      method,
      projectRef: options.project ?? projectA.slug,
      segments: path.split("/").filter(Boolean),
      body,
      searchParams: new URLSearchParams(options.query ?? ""),
      idempotencyKey: options.idempotencyKey ?? null,
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.payload)) };
  } catch (error) {
    if (error instanceof ConsoleApiError) return { status: error.status, body: error.payload };
    throw error;
  }
}

async function attempt<T>(fn: () => Promise<T>): Promise<Res> {
  try {
    return { status: 200, body: JSON.parse(JSON.stringify(await fn())) };
  } catch (error) {
    if (error instanceof ConsoleApiError) return { status: error.status, body: error.payload };
    throw error;
  }
}

function expectError(res: Res, status: number, error?: string) {
  if (res.status !== status || (error && res.body?.error !== error)) {
    throw new Error(`expected ${status} ${error ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
}

function expectOk(res: Res, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const SEED: Array<{ label: string; values: Record<string, unknown> }> = [];

describeDb("bases service (db)", () => {
  const rowIds = new Map<string, string>();
  let base: J;
  let stageIds: Record<string, string> = {};
  const views = {} as { agg: string; chart: string; form: string; leads: string; mine: string };

  const rowId = (label: string) => {
    const id = rowIds.get(label);
    if (!id) throw new Error(`unknown row ${label}`);
    return id;
  };
  const versionOf = async (label: string) => {
    const [row] = await db.select({ version: schema.baseRows.version }).from(schema.baseRows).where(eq(schema.baseRows.id, rowId(label)));
    return row?.version ?? 0;
  };
  const inboxItems = async () =>
    db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.targetId, installationId)));
  const createView = async (body: Record<string, unknown>) => {
    const res = await call(consoleCaller(owner), "POST", "crm/views", body);
    return expectOk(res, 201);
  };

  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([
      { id: orgId, slug: `bases-svc-${suffix}`, name: "Bases service test" },
      { id: otherOrgId, slug: `bases-svc-other-${suffix}`, name: "Other org" },
    ]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([
      { projectId: projectA.id, userId: viewer.id, role: "viewer" },
      { projectId: projectA.id, userId: projDev.id, role: "developer" },
      { projectId: projectA.id, userId: billing.id, role: "viewer" },
    ]);
    await db.insert(schema.pageSites).values([
      { id: siteA, organizationId: orgId, projectId: projectA.id, slug: `bt-a-${suffix}`, defaultHostname: `bt-a-${suffix}.ravi.page.test` },
      { id: siteB, organizationId: orgId, projectId: projectB.id, slug: `bt-b-${suffix}`, defaultHostname: `bt-b-${suffix}.ravi.page.test` },
    ]);
    await db.insert(schema.localInstallations).values([
      { id: installationId, organizationId: orgId, userId: dev.id, name: "dev laptop" },
      { id: revokedInstallationId, organizationId: orgId, userId: dev.id, name: "old laptop", status: "revoked", revokedAt: new Date() },
    ]);
    cliSession = await basesCliFixture(orgId, installationId, [dev.id, viewer.id]);
    await basesPolicyFixture(orgId, owner.id, [
      { projectId: projectA.id, managers: [owner.id, dev.id, projDev.id], readers: [viewer.id, billing.id], viewWriters: [viewer.id, billing.id], installations: [installationId] },
      { projectId: projectB.id, managers: [owner.id, dev.id] },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  // -------------------------------------------------------------------------
  // Bases

  test("managers create bases with a default view; slugs are validated and unique", async () => {
    const created = expectOk(
      await call(consoleCaller(owner), "POST", "", {
        slug: "crm",
        name: "CRM",
        timezone: "America/Sao_Paulo",
        properties: [
          { key: "name", name: "Name", type: "text", required: true },
          { key: "amount", name: "Amount", type: "number" },
          { key: "stage", name: "Stage", type: "select", config: { options: [{ name: "Lead" }, { name: "Won" }, { name: "Lost" }] } },
          { key: "owner", name: "Owner", type: "person" },
          { key: "email", name: "Email", type: "email" },
          { key: "secret", name: "Secret", type: "text" },
          { key: "notes", name: "Notes", type: "text" },
          { key: "score", name: "Score", type: "text" },
        ],
      }),
      201,
    );
    base = created;
    expect(created.slug).toBe("crm");
    expect(created.capabilities).toEqual({ manage: true, readDirect: true, writeDirect: true });
    expect(created.views).toHaveLength(1);
    expect(created.views[0].name).toBe("All rows");
    expect(created.views[0].columns).toEqual(["name", "amount", "stage", "owner", "email", "secret", "notes", "score", "body"]);
    expect(created.views[0].access.read).toEqual([]);
    expect(created.members.map((member: J) => member.id).sort()).toEqual(USERS.map((user) => user.id).sort());
    expect(JSON.stringify(created.members)).not.toContain("@example.test");
    stageIds = Object.fromEntries(created.properties.find((p: J) => p.key === "stage").config.options.map((o: J) => [o.name, o.id]));

    const derived = expectOk(await call(consoleCaller(dev), "POST", "", { name: "My CRM" }), 201);
    expect(derived.slug).toBe("my-crm");
    expect(expectOk(await call(consoleCaller(dev), "POST", "", { name: "My CRM" }), 201).slug).toBe("my-crm-2");
    expectError(await call(consoleCaller(owner), "POST", "", { slug: "crm", name: "Again" }), 409, "slug_taken");
    const invalid = await call(consoleCaller(owner), "POST", "", { slug: "Bad Slug", name: "Bad" });
    expectError(invalid, 400, "validation_failed");
    expect(invalid.body.fieldErrors.slug).toBeString();
    expectError(await call(consoleCaller(owner), "POST", "", { name: "TZ", timezone: "Mars/Base" }), 400, "validation_failed");
    const zoned = expectOk(await call(consoleCaller(dev), "PATCH", "my-crm", { timezone: "america/sao_paulo", expectedVersion: derived.version }));
    expect(zoned.timezone).toBe("America/Sao_Paulo");
    expectError(await call(consoleCaller(viewer), "POST", "", { name: "Nope" }), 403, "base_forbidden");
    expectError(await call(consoleCaller(projDev), "POST", "", { name: "x", sql: "select 1" }), 400, "payload_invalid");
  });

  // -------------------------------------------------------------------------
  // Storage And Scope

  test("every read is scoped by the caller organization and an accessible project", async () => {
    expect(expectOk(await call(consoleCaller(owner), "GET", "")).bases.map((b: J) => b.slug)).toEqual(["crm", "my-crm", "my-crm-2"]);
    expectError(await call(consoleCaller(outsider), "GET", ""), 404, "not_found");
    expectError(await call(consoleCaller(owner, otherOrgId), "GET", "crm"), 404, "not_found");
    expectError(await call(consoleCaller(owner), "GET", "crm", {}, { project: projectB.slug }), 404, "not_found");
    expectError(await call(consoleCaller(owner), "GET", base.id, {}, { project: projectB.id }), 404, "not_found");
    expect(expectOk(await call(consoleCaller(owner), "GET", base.id, {}, { project: projectA.id })).slug).toBe("crm");
    // View-only callers see no base until a view admits them.
    expect(expectOk(await call(consoleCaller(viewer), "GET", "")).bases).toEqual([]);
    expectError(await call(consoleCaller(viewer), "GET", "crm"), 404, "not_found");
  });

  test("seed rows (batch create)", async () => {
    const rows = [
      { label: "r1", values: { name: "Acme", amount: 100, stage: "Lead", owner: [viewer.id], email: "A@X.com", secret: "s1", notes: "n1", score: "10" } },
      { label: "r2", values: { name: "Beta", amount: 250, stage: "Lead", owner: [viewer.id], score: "abc" } },
      { label: "r3", values: { name: "Gamma", amount: 50, stage: "Won", owner: [viewer.id], secret: "s3" } },
      { label: "r4", values: { name: "Delta", stage: "Lead", owner: [projDev.id] } },
      { label: "r5", values: { name: "50% off", amount: 10, stage: "Lost", owner: [projDev.id] } },
      { label: "r6", values: { name: "Zeta", amount: 500, stage: "Lead", owner: [dev.id] } },
      { label: "r7", values: { name: "Eta", amount: 75, stage: "Won", owner: [dev.id] } },
      { label: "r8", values: { name: "Theta", stage: "Lead" } },
      { label: "r9", values: { name: "Iota", amount: 120, stage: "Won" } },
      { label: "r10", values: { name: "Kappa", amount: 5, stage: "Lost" } },
      { label: "r11", values: { name: "Lambda", amount: 300 } },
      { label: "r12", values: { name: "Mu", amount: 1000, stage: "Lead", owner: [viewer.id, dev.id] } },
    ];
    SEED.push(...rows);
    const res = expectOk(
      await call(consoleCaller(owner), "POST", "crm/rows", { rows: rows.map((row) => ({ values: row.values })), idempotencyKey: idem("seed") }),
      201,
    );
    expect(res.rows).toHaveLength(12);
    res.rows.forEach((row: J, index: number) => rowIds.set(rows[index]!.label, row.rowId));
    expect(res.rows[0].values.email).toBe("a@x.com");
    expect(res.rows[0].values.stage).toBe(stageIds.Lead);
  });

  test("org viewer, billing, and project viewer members have no direct row access", async () => {
    for (const user of [viewer, billing]) {
      expectError(await call(consoleCaller(user), "POST", "crm/rows/query", {}), 403, "base_forbidden");
      expectError(await call(consoleCaller(user), "POST", "crm/rows/aggregate", { aggregate: [{ op: "count", as: "n" }] }), 403, "base_forbidden");
      expectError(await call(consoleCaller(user), "GET", `crm/rows/${rowId("r1")}`), 403, "base_forbidden");
      expectError(await call(consoleCaller(user), "GET", `crm/rows/${rowId("r1")}/history`), 403, "base_forbidden");
      expectError(
        await call(consoleCaller(user), "POST", "crm/rows", { values: { name: "x" }, idempotencyKey: idem() }),
        403,
        "base_forbidden",
      );
    }
    // Project developers and org developers manage.
    expect(expectOk(await call(consoleCaller(projDev), "POST", "crm/rows/query", {})).rows).toHaveLength(12);
    expect(expectOk(await call(consoleCaller(dev), "POST", "crm/rows/query", { limit: 1 })).rows).toHaveLength(1);
  });

  test("capability probes on every request write no decision-audit rows", async () => {
    const probeRows = async () => {
      const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM authorization_audit WHERE organization_id = ${orgId}::uuid
        AND action IN ('project.write', 'bases.view.write', 'project.list')`)) as unknown as Array<{ n: number }>;
      return Number(rows[0]!.n);
    };
    const before = await probeRows();
    // Manager (write allowed), view writer (write denied, view write allowed) and reader.
    expectOk(await call(consoleCaller(owner), "GET", ""));
    expectOk(await call(consoleCaller(projDev), "POST", "crm/rows/query", { limit: 1 }));
    for (const user of [viewer, billing]) expectOk(await call(consoleCaller(user), "GET", ""));
    expectError(await call(consoleCaller(viewer), "POST", "crm/rows/query", {}), 403, "base_forbidden");
    expect(await probeRows()).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Query AST

  test("no raw SQL; unknown operators, properties, type mismatches, and oversized ASTs are rejected", async () => {
    const q = (body: unknown) => call(consoleCaller(owner), "POST", "crm/rows/query", body);
    expectError(await q({ sql: "select 1" }), 400, "payload_invalid");
    expectError(await q({ filter: "true; drop table bases" }), 400, "invalid_filter");
    expectError(await q({ filter: { prop: "amount", op: "regex", value: ".*" } }), 400, "invalid_filter");
    expectError(await q({ filter: { prop: "nope", op: "eq", value: 1 } }), 400, "unknown_property");
    expectError(await q({ filter: { prop: "amount", op: "eq", value: "abc" } }), 400, "invalid_filter");
    expectError(await q({ filter: { prop: "amount", op: "contains", value: 1 } }), 400, "invalid_filter");
    let deep: J = { prop: "amount", op: "gt", value: 1 };
    for (let i = 0; i < 9; i += 1) deep = { not: deep };
    expect((await q({ filter: deep })).status).toBe(400);
    const wide = { or: [{ and: Array.from({ length: 32 }, () => ({ prop: "amount", op: "gt", value: 1 })) }, { and: Array.from({ length: 32 }, () => ({ prop: "amount", op: "gt", value: 1 })) }, { prop: "amount", op: "gt", value: 1 }] };
    expect((await q({ filter: wide })).status).toBe(400);
    expectError(
      await q({ sort: [{ prop: "amount" }, { prop: "name" }, { prop: "stage" }, { prop: "created_time" }] }),
      400,
      "payload_invalid",
    );
    expectError(
      await call(consoleCaller(owner), "POST", "crm/rows/aggregate", {
        groupBy: [{ prop: "stage" }, { prop: "owner" }, { prop: "amount" }],
        aggregate: [{ op: "count", as: "n" }],
      }),
      400,
      "payload_invalid",
    );
  });

  test("unknown operators and malformed nodes are invalid_filter naming the problem on every surface that takes a filter", async () => {
    const gtx = { prop: "amount", op: "gtx", value: 1 };
    const extra = { and: [{ prop: "amount", op: "gt", value: 1 }], limit: 5 };
    const expectReason = (res: Res, reason: string) => {
      expectError(res, 400, "invalid_filter");
      expect(res.body.reason).toContain(reason);
    };
    const send = (method: string, path: string, body: unknown) => call(consoleCaller(owner), method, path, body);
    expectReason(await send("POST", "crm/rows/query", { filter: gtx }), 'Unknown operator "gtx"');
    expectReason(await send("POST", "crm/rows/query", { filter: { prop: "amount", value: 1 } }), "needs an op");
    expectReason(await send("POST", "crm/rows/query", { filter: { ...gtx, op: "gt", limit: 5 } }), 'Unknown filter key "limit"');
    expectReason(await send("POST", "crm/rows/aggregate", { filter: extra, aggregate: [{ op: "count", as: "n" }] }), 'Unexpected key "limit"');
    expectReason(await send("POST", "crm/views", { name: "Bad filter", columns: ["name", "amount"], query: { filter: gtx } }), 'Unknown operator "gtx"');

    const view = await createView({ name: "Filter errors", columns: ["name", "amount"] });
    expectReason(await send("PATCH", `crm/views/${view.id}`, { expectedVersion: view.version, query: { filter: gtx } }), 'Unknown operator "gtx"');
    expectReason(await send("POST", `crm/views/${view.id}/query`, { filter: { or: gtx } }), '"or" takes an array');
    // Other malformed fields are still payload_invalid.
    expectError(await send("POST", "crm/rows/query", { filter: null, limit: 0 }), 400, "payload_invalid");
  });

  test("not of a leaf is the exact complement over active rows, including empty values", async () => {
    const count = async (filter: unknown) => expectOk(await call(consoleCaller(owner), "POST", "crm/rows/query", { filter, limit: 500 })).rows.length;
    const leaf = { prop: "amount", op: "gte", value: 100 };
    const matching = await count(leaf);
    const complement = await count({ not: leaf });
    expect(matching).toBe(6);
    expect(matching + complement).toBe(12);
    const names = expectOk(await call(consoleCaller(owner), "POST", "crm/rows/query", { filter: { not: leaf }, limit: 500 })).rows.map((r: J) => r.values.name);
    expect(names).toContain("Delta");
    expect(names).toContain("Theta");
  });

  test("contains, not_contains, and starts_with escape %, _, and \\", async () => {
    const names = async (filter: unknown) =>
      expectOk(await call(consoleCaller(owner), "POST", "crm/rows/query", { filter })).rows.map((r: J) => r.values.name);
    expect(await names({ prop: "name", op: "contains", value: "%" })).toEqual(["50% off"]);
    expect(await names({ prop: "name", op: "contains", value: "_" })).toEqual([]);
    expect(await names({ prop: "name", op: "starts_with", value: "\\" })).toEqual([]);
    expect((await names({ prop: "name", op: "not_contains", value: "%" })).length).toBe(11);
  });

  test("$viewer variables come only from the caller and fail closed without one", async () => {
    const system = basesSystemCaller(orgId, randomUUID());
    const ownerWorkspace = { user: { id: owner.id }, organization: { id: orgId }, membership: { role: "owner" } };
    const res = await call(system, "POST", "crm/rows/query", { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" } }, { workspace: ownerWorkspace });
    expectError(res, 403, "base_forbidden");
    // Generic system calls now fail before filter evaluation, even if supplied
    // an owner workspace. Compiler's separate null-viewer regression remains.
    expect(res.body.reason).toBe("Service operation is outside its job scope.");
    expectError(
      await call(consoleCaller(owner), "POST", "crm/rows/query", { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" }, viewer: { raviUserId: viewer.id } }),
      400,
      "payload_invalid",
    );
    expectError(
      await call(consoleCaller(owner), "POST", "crm/rows/query", { filter: { prop: "name", op: "contains", value: "$viewer.email" } }),
      400,
      "invalid_filter",
    );
    const mine = expectOk(
      await call(consoleCaller(projDev), "POST", "crm/rows/query", { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" } }),
    );
    expect(mine.rows.map((r: J) => r.values.name).sort()).toEqual(["50% off", "Delta"]);
  });

  // -------------------------------------------------------------------------
  // Charts (before writes change the seeded groups)

  test("chart fields must be view columns; aggregate-mode principals get suppressed groups only", async () => {
    const agg = await createView({
      name: "Pipeline stats",
      columns: ["stage", "amount"],
      layout: { type: "chart", chartId: randomUUID() },
      access: { read: [{ kind: "project_role", minRole: "viewer", mode: "aggregate" }] },
    }).catch(() => null);
    expect(agg).toBeNull();
    const view = await createView({ name: "Pipeline stats", columns: ["stage", "amount"], access: { read: [{ kind: "project_role", minRole: "viewer", mode: "aggregate" }] } });
    views.agg = view.id;
    expectError(
      await call(consoleCaller(owner), "POST", "crm/charts", {
        viewId: view.id,
        name: "By email",
        spec: { mark: "bar", encoding: { x: { field: "email", type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } },
      }),
      400,
      "unknown_property",
    );
    const chart = expectOk(
      await call(consoleCaller(owner), "POST", "crm/charts", {
        viewId: view.id,
        name: "By stage",
        spec: { mark: "bar", encoding: { x: { field: "stage", type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } },
      }),
      201,
    );
    views.chart = chart.id;
    expect(chart.spec.encoding.x.field).toBe("stage");

    const asViewer = expectOk(await call(consoleCaller(viewer), "POST", `crm/charts/${chart.id}/data`, {}));
    expect(asViewer.data).toEqual([{ x: stageIds.Lead, y: 6 }]);
    expect(asViewer.suppressedGroups).toBe(3);
    expect(Object.keys(asViewer.fields)).toEqual(["stage"]);
    expect(asViewer.chart.status).toBeUndefined();
    const asManager = expectOk(await call(consoleCaller(owner), "POST", `crm/charts/${chart.id}/data`, {}));
    expect(asManager.suppressedGroups).toBe(0);
    expect(asManager.data).toHaveLength(4);
    expectError(await call(consoleCaller(viewer), "POST", `crm/charts/${chart.id}/data`, { filter: {} }), 400, "validation_failed");

    // Aggregate mode never reads rows.
    expectError(await call(consoleCaller(viewer), "POST", `crm/views/${view.id}/query`, {}), 403, "base_forbidden");
    expectError(await call(consoleCaller(viewer), "GET", `crm/views/${view.id}/rows/${rowId("r1")}`), 403, "base_forbidden");
    const detail = expectOk(await call(consoleCaller(viewer), "GET", "crm"));
    expect(detail.properties).toEqual([]);
    expect(detail.charts.map((c: J) => c.id)).toEqual([chart.id]);
    expect(detail.views[0].capabilities).toMatchObject({ read: false, aggregateOnly: true });
  });

  // -------------------------------------------------------------------------
  // Views

  test("view save rejects write columns outside the view and create views that miss required properties", async () => {
    const bad = await call(consoleCaller(owner), "POST", "crm/views", {
      name: "Bad",
      columns: ["name", "stage"],
      access: { write: { principals: [{ kind: "project_role", minRole: "viewer" }], columns: ["amount"] } },
    });
    expectError(bad, 400, "validation_failed");
    expect(bad.body.fieldErrors["access.write.columns"]).toBeString();
    const form = await call(consoleCaller(owner), "POST", "crm/views", {
      name: "Form",
      columns: ["stage"],
      access: { write: { principals: [{ kind: "project_role", minRole: "viewer" }], columns: ["stage"], create: true } },
    });
    expectError(form, 400, "validation_failed");
    expect(form.body.fieldErrors["access.write.create"]).toContain("name");
    const site = await call(consoleCaller(owner), "POST", "crm/views", { name: "Other site", access: { read: [{ kind: "page_viewer", siteId: siteB }] } });
    expectError(site, 400, "validation_failed");
    const stranger = await call(consoleCaller(owner), "POST", "crm/views", { name: "Stranger", access: { read: [{ kind: "user", userId: randomUUID() }] } });
    expectError(stranger, 400, "validation_failed");
    expectError(await call(consoleCaller(viewer), "POST", "crm/views", { name: "Mine" }), 403, "base_forbidden");
  });

  test("views project columns, AND request filters, and hide policy from non-managers", async () => {
    const mine = await createView({
      name: "My pipeline",
      columns: ["name", "stage", "amount", "owner", "created_time"],
      query: {
        filter: { and: [{ prop: "owner", op: "contains", value: "$viewer.raviUserId" }, { prop: "stage", op: "neq", value: "Lost" }] },
        sort: [{ prop: "amount", dir: "desc" }],
      },
      access: {
        read: [{ kind: "project_role", minRole: "viewer" }],
        write: { principals: [{ kind: "project_role", minRole: "viewer" }], columns: ["stage", "amount"], archive: true },
      },
    });
    views.mine = mine.id;
    expect(mine.query.filter.and[1].value).toBe(stageIds.Lost);

    const q = (caller: BasesCaller, body: unknown = {}) => call(caller, "POST", `crm/views/${mine.id}/query`, body);
    const asViewer = expectOk(await q(consoleCaller(viewer)));
    expect(asViewer.rows.map((r: J) => r.values.name)).toEqual(["Mu", "Beta", "Acme", "Gamma"]);
    expect(asViewer.columns).toEqual(["name", "stage", "amount", "owner", "created_time"]);
    for (const row of asViewer.rows) {
      expect(Object.keys(row).sort()).toEqual(["rowId", "values", "version"]);
      for (const key of Object.keys(row.values)) expect(["name", "stage", "amount", "owner", "created_time"]).toContain(key);
    }
    expect(Object.keys(asViewer.users).sort()).toEqual([dev.id, viewer.id].sort());
    expect(JSON.stringify(asViewer)).not.toContain("example.test");

    // Request filters only narrow.
    expect(expectOk(await q(consoleCaller(viewer), { filter: { prop: "stage", op: "eq", value: "Won" } })).rows.map((r: J) => r.values.name)).toEqual(["Gamma"]);
    expect(
      expectOk(await q(consoleCaller(viewer), { filter: { or: [{ prop: "amount", op: "is_empty" }, { prop: "amount", op: "is_not_empty" }] } })).rows,
    ).toHaveLength(4);
    // Managers read through the view with their own viewer variables.
    expect(expectOk(await q(consoleCaller(projDev))).rows.map((r: J) => r.values.name)).toEqual(["Delta"]);

    // Non-projected columns fail exactly like unknown keys.
    const hidden = await q(consoleCaller(viewer), { filter: { prop: "secret", op: "eq", value: "s1" } });
    const unknown = await q(consoleCaller(viewer), { filter: { prop: "nothere", op: "eq", value: "s1" } });
    expectError(hidden, 400, "unknown_property");
    expectError(unknown, 400, "unknown_property");
    expect(hidden.body.reason.replace("secret", "?")).toBe(unknown.body.reason.replace("nothere", "?"));
    expectError(await q(consoleCaller(viewer), { sort: [{ prop: "email", dir: "asc" }] }), 400, "unknown_property");
    expectError(await q(consoleCaller(viewer), { includeArchived: true }), 400, "payload_invalid");

    // Public shapes only.
    const detail = expectOk(await call(consoleCaller(viewer), "GET", "crm"));
    expect(detail.properties).toEqual([]);
    expect(detail.members).toEqual([]);
    expect(detail.rowCount).toBeNull();
    expect(detail.capabilities).toEqual({ manage: false, readDirect: false, writeDirect: false });
    for (const view of detail.views) {
      expect(view.query).toBeUndefined();
      expect(view.access).toBeUndefined();
    }
    const text = JSON.stringify(detail);
    for (const hiddenKey of ["secret", "Secret", "notes", "email", "score", "$viewer"]) expect(text).not.toContain(hiddenKey);
    const described = expectOk(await call(consoleCaller(viewer), "GET", `crm/views/${mine.id}`));
    expect(described.view).toBeUndefined();
    expect(described.columns.map((c: J) => c.key)).toEqual(["name", "stage", "amount", "owner", "created_time"]);
    expect(described.capabilities).toEqual({ read: true, aggregateOnly: false, writeColumns: ["stage", "amount"], create: false, archive: true, manage: false, approve: [] });
    expect(expectOk(await call(consoleCaller(owner), "GET", `crm/views/${mine.id}`)).view.access.read).toHaveLength(1);
    expect(expectOk(await call(consoleCaller(viewer), "GET", "")).bases.map((b: J) => b.slug)).toEqual(["crm"]);
    expect(expectOk(await call(consoleCaller(viewer), "GET", "crm/views")).views.map((v: J) => v.id).sort()).toEqual([views.agg, mine.id].sort());
    // The "All rows" view admits nobody else.
    expectError(await call(consoleCaller(viewer), "GET", `crm/views/${base.views[0].id}`), 404, "not_found");
  });

  // -------------------------------------------------------------------------
  // Writes

  test("writes through a view are limited to write.columns; preset keys cannot be supplied", async () => {
    const patch = (label: string, body: Record<string, unknown>) =>
      call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId(label)}`, { idempotencyKey: idem(), ...body });
    const notWritable = await patch("r1", { values: { name: "Renamed" }, expectedVersion: 1 });
    expectError(notWritable, 400, "validation_failed");
    expect(notWritable.body.fieldErrors.name).toBeString();
    expectError(await patch("r1", { values: { secret: "x" }, expectedVersion: 1 }), 400, "validation_failed");
    expectError(await patch("r1", { body: "notes", expectedVersion: 1 }), 400, "validation_failed");
    const updated = expectOk(await patch("r1", { values: { stage: "Won", amount: 110 }, expectedVersion: 1 }));
    expect(updated.row.version).toBe(2);
    expect(updated.row.values).toMatchObject({ stage: stageIds.Won, amount: 110, name: "Acme" });
    expect(Object.keys(updated.row.values)).not.toContain("secret");

    const form = await createView({
      name: "Intake",
      columns: ["name", "stage", "owner"],
      query: { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" }, sort: [] },
      layout: { type: "form", title: "New lead" },
      access: {
        read: [],
        write: { principals: [{ kind: "project_role", minRole: "viewer" }], columns: ["name", "stage"], create: true, set: { owner: "$viewer.raviUserId" } },
      },
    });
    views.form = form.id;
    const supplied = await call(consoleCaller(viewer), "POST", `crm/views/${form.id}/rows`, {
      values: { name: "Lead from form", owner: [dev.id] },
      idempotencyKey: idem(),
    });
    expectError(supplied, 400, "validation_failed");
    expect(supplied.body.fieldErrors.owner).toBeString();
    const created = expectOk(
      await call(consoleCaller(viewer), "POST", `crm/views/${form.id}/rows`, { values: { name: "Lead from form", stage: "Lead" }, idempotencyKey: idem() }),
      201,
    );
    // Writers without row read get ids and version only; the preset was stored.
    expect(created.row.values).toEqual({});
    rowIds.set("form1", created.row.rowId);
    const stored = expectOk(await call(consoleCaller(owner), "GET", `crm/rows/${created.row.rowId}`));
    expect(stored.row.values.owner).toEqual([viewer.id]);
    // Write-only principals cannot read through the form.
    expectError(await call(consoleCaller(viewer), "POST", `crm/views/${form.id}/query`, {}), 403, "base_forbidden");
  });

  test("updates and archives outside the view filter are not_found, never conflict or forbidden", async () => {
    for (const label of ["r4", "r5", "r10"]) {
      expectError(
        await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId(label)}`, { values: { stage: "Won" }, expectedVersion: 99, idempotencyKey: idem() }),
        404,
        "not_found",
      );
      expectError(await call(consoleCaller(viewer), "POST", `crm/views/${views.mine}/rows/${rowId(label)}/archive`, { expectedVersion: 99 }), 404, "not_found");
      expectError(await call(consoleCaller(viewer), "GET", `crm/views/${views.mine}/rows/${rowId(label)}`), 404, "not_found");
      expectError(await call(consoleCaller(viewer), "GET", `crm/views/${views.mine}/rows/${rowId(label)}/history`), 404, "not_found");
    }
    expectError(await call(consoleCaller(viewer), "GET", `crm/views/${views.mine}/rows/${randomUUID()}`), 404, "not_found");
  });

  test("writes that leave the view filter roll back with write_escapes_view unless allowEscape", async () => {
    const before = await versionOf("r2");
    const escaped = await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId("r2")}`, {
      values: { stage: "Lost" },
      expectedVersion: before,
      idempotencyKey: idem(),
    });
    expectError(escaped, 409, "write_escapes_view");
    expect(await versionOf("r2")).toBe(before);

    const leads = await createView({
      name: "Leads",
      columns: ["name", "stage"],
      query: { filter: { prop: "stage", op: "eq", value: "Lead" }, sort: [] },
      access: { read: [{ kind: "user", userId: viewer.id }], write: { principals: [{ kind: "user", userId: viewer.id }], columns: ["name", "stage"], create: true } },
    });
    views.leads = leads.id;
    const [{ count: rowsBefore }] = (await db.execute(sql`SELECT count(*)::int AS count FROM base_rows WHERE base_id = ${base.id}::uuid`)) as unknown as [{ count: number }];
    expectError(
      await call(consoleCaller(viewer), "POST", `crm/views/${leads.id}/rows`, { values: { name: "Won deal", stage: "Won" }, idempotencyKey: idem() }),
      409,
      "write_escapes_view",
    );
    const [{ count: rowsAfter }] = (await db.execute(sql`SELECT count(*)::int AS count FROM base_rows WHERE base_id = ${base.id}::uuid`)) as unknown as [{ count: number }];
    expect(rowsAfter).toBe(rowsBefore);
    const updatedView = expectOk(
      await call(consoleCaller(owner), "PATCH", `crm/views/${leads.id}`, {
        expectedVersion: leads.version,
        access: { ...leads.access, write: { ...leads.access.write, allowEscape: true } },
      }),
    );
    expect(updatedView.access.write.allowEscape).toBe(true);
    const escapedCreate = expectOk(
      await call(consoleCaller(viewer), "POST", `crm/views/${leads.id}/rows`, { values: { name: "Won deal", stage: "Won" }, idempotencyKey: idem() }),
      201,
    );
    rowIds.set("escaped", escapedCreate.row.rowId);
  });

  test("stale expectedVersion conflicts without writing; omitting it needs lastWriteWins", async () => {
    const current = await versionOf("r3");
    const stale = await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId("r3")}`, {
      values: { amount: 1 },
      expectedVersion: current - 1 || 99,
      idempotencyKey: idem(),
    });
    expectError(stale, 409, "version_conflict");
    expect(stale.body.current.rowId).toBe(rowId("r3"));
    expect(Object.keys(stale.body.current.values).sort()).toEqual(["amount", "created_time", "name", "owner", "stage"]);
    expect(stale.body.current.values.amount).toBe(50);
    expect(await versionOf("r3")).toBe(current);
    const missing = await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId("r3")}`, { values: { amount: 1 }, idempotencyKey: idem() });
    expectError(missing, 400, "validation_failed");
    expect(missing.body.fieldErrors.expectedVersion).toBeString();
    const lww = expectOk(
      await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId("r3")}`, { values: { amount: 55 }, lastWriteWins: true, idempotencyKey: idem() }),
    );
    expect(lww.row.version).toBe(current + 1);
    const [entry] = await db
      .select()
      .from(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.rowId, rowId("r3")), eq(schema.baseRowLedger.version, current + 1)));
    expect(entry?.lastWriteWins).toBe(true);
  });

  test("retries with the same key create one row; a different body is idempotency_conflict", async () => {
    const key = idem("retry");
    const body = { values: { name: "Retry Co", stage: "Lead" }, idempotencyKey: key };
    const first = expectOk(await call(consoleCaller(viewer), "POST", `crm/views/${views.leads}/rows`, body), 201);
    const second = expectOk(await call(consoleCaller(viewer), "POST", `crm/views/${views.leads}/rows`, body), 200);
    expect(second.idempotentReplay).toBe(true);
    expect(second.row.rowId).toBe(first.row.rowId);
    expect(Object.keys(second.row.values).sort()).toEqual(["name", "stage"]);
    const stored = await db.select().from(schema.baseRows).where(and(eq(schema.baseRows.baseId, base.id), sql`${schema.baseRows.valuesJson} ->> ${base.properties[0].id}::text = 'Retry Co'`));
    expect(stored).toHaveLength(1);
    expectError(
      await call(consoleCaller(viewer), "POST", `crm/views/${views.leads}/rows`, { ...body, values: { name: "Other Co", stage: "Lead" } }),
      409,
      "idempotency_conflict",
    );
    // The header works too, and the same key is scoped per source.
    const viaHeader = expectOk(
      await call(consoleCaller(owner), "POST", "crm/rows", { values: { name: "Header Co" } }, { idempotencyKey: key }),
      201,
    );
    expect(viaHeader.idempotentReplay).toBe(false);
    const update = { values: { stage: "Won" }, expectedVersion: 1, idempotencyKey: idem("upd") };
    const u1 = expectOk(await call(consoleCaller(owner), "PATCH", `crm/rows/${viaHeader.row.rowId}`, update));
    const u2 = expectOk(await call(consoleCaller(owner), "PATCH", `crm/rows/${viaHeader.row.rowId}`, update));
    expect(u2.idempotentReplay).toBe(true);
    expect(u2.row.version).toBe(u1.row.version);
  });

  test("every row mutation appends a ledger entry with actor, surface, view, and changed properties", async () => {
    const version = await versionOf("r6");
    const cli = cliCaller(dev, installationId, { agentId: "main", sessionKey: "agent:main:main", token: "nope" });
    const res = expectOk(
      await call(cli, "PATCH", `crm/views/${views.mine}/rows/${rowId("r6")}`, { values: { amount: 600 }, expectedVersion: version, idempotencyKey: idem(), clientHint: { agentId: "ignored" } }),
    );
    expect(res.row.values.amount).toBe(600);
    const [entry] = await db
      .select()
      .from(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.rowId, rowId("r6")), eq(schema.baseRowLedger.version, version + 1)));
    const amountId = base.properties.find((p: J) => p.key === "amount").id;
    expect(entry).toMatchObject({
      action: "updated",
      actorType: "cli",
      actorId: dev.id,
      surface: "cli",
      viewId: views.mine,
      changedPropertyIds: [amountId],
      beforeJson: { [amountId]: 500 },
      afterJson: { [amountId]: 600 },
      bodyChanged: false,
      lastWriteWins: false,
      clientHintJson: { agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(entry?.requestId).toBe(cli.requestId);
    const created = await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.rowId, rowId("form1")));
    expect(created[0]).toMatchObject({ action: "created", actorType: "user", actorId: viewer.id, surface: "console", viewId: views.form });

    // History through a view shows only projected columns; directly, managers see everything.
    const history = expectOk(await call(consoleCaller(viewer), "GET", `crm/views/${views.mine}/rows/${rowId("r1")}/history`));
    expect(history.entries.map((e: J) => e.action)).toEqual(["updated", "created"]);
    for (const entry of history.entries) {
      for (const key of [...entry.changedKeys, ...Object.keys(entry.before), ...Object.keys(entry.after)]) {
        expect(["name", "stage", "amount", "owner", "created_time"]).toContain(key);
      }
      expect(entry.bodyChanged).toBe(false);
    }
    const direct = expectOk(await call(consoleCaller(owner), "GET", `crm/rows/${rowId("r1")}/history`));
    expect(direct.entries.at(-1).changedKeys).toContain("secret");
    expectError(await call(consoleCaller(viewer), "GET", `crm/rows/${rowId("r1")}/history`), 403, "base_forbidden");
  });

  // -------------------------------------------------------------------------
  // Cursors

  test("cursors bind view, view version, schema version, query, and caller", async () => {
    const page = async (caller: BasesCaller, viewId: string, body: Record<string, unknown> = {}) =>
      call(caller, "POST", `crm/views/${viewId}/query`, { limit: 1, ...body });
    const first = expectOk(await page(consoleCaller(viewer), views.mine));
    expect(first.nextCursor).toBeString();
    const cursor = first.nextCursor as string;
    expect(expectOk(await page(consoleCaller(viewer), views.mine, { cursor })).rows).toHaveLength(1);
    expectError(await page(consoleCaller(viewer), views.leads, { cursor }), 400, "cursor_invalid");
    expectError(await page(consoleCaller(projDev), views.mine, { cursor }), 400, "cursor_invalid");
    expectError(await page(consoleCaller(viewer), views.mine, { cursor, filter: { prop: "stage", op: "eq", value: "Won" } }), 400, "cursor_invalid");
    const tampered = cursor.slice(0, -2) + (cursor.endsWith("A") ? "BB" : "AA");
    expectError(await page(consoleCaller(viewer), views.mine, { cursor: tampered }), 400, "cursor_invalid");

    const direct = expectOk(await call(consoleCaller(owner), "POST", "crm/rows/query", { limit: 1 }));
    expectError(await page(consoleCaller(owner), views.mine, { cursor: direct.nextCursor }), 400, "cursor_invalid");

    const view = expectOk(await call(consoleCaller(owner), "GET", `crm/views/${views.mine}`)).view;
    expectOk(await call(consoleCaller(owner), "PATCH", `crm/views/${views.mine}`, { expectedVersion: view.version, name: "My pipeline v2" }));
    expectError(await page(consoleCaller(viewer), views.mine, { cursor }), 400, "cursor_invalid");

    const fresh = expectOk(await page(consoleCaller(viewer), views.mine)).nextCursor as string;
    const schemaVersion = expectOk(await call(consoleCaller(owner), "GET", "crm")).schemaVersion;
    expectOk(await call(consoleCaller(owner), "POST", "crm/properties", { expectedSchemaVersion: schemaVersion, name: "Region", type: "text" }));
    expectError(await page(consoleCaller(viewer), views.mine, { cursor: fresh }), 400, "cursor_invalid");
  });

  // -------------------------------------------------------------------------
  // Properties and view validity

  test("property mutations need expectedSchemaVersion; migrations are dry-run by default", async () => {
    let detail = expectOk(await call(consoleCaller(owner), "GET", "crm"));
    expectError(await call(consoleCaller(owner), "PATCH", "crm/properties/score", { name: "Score" }), 400, "payload_invalid");
    const stale = await call(consoleCaller(owner), "PATCH", "crm/properties/score", { expectedSchemaVersion: detail.schemaVersion - 1, name: "Score" });
    expectError(stale, 409, "schema_version_conflict");
    expect(stale.body.schemaVersion).toBe(detail.schemaVersion);
    expectError(await call(consoleCaller(owner), "POST", "crm/properties", { expectedSchemaVersion: detail.schemaVersion, key: "row_id", name: "Row", type: "text" }), 400, "validation_failed");
    expectError(await call(consoleCaller(owner), "POST", "crm/properties", { expectedSchemaVersion: detail.schemaVersion, key: "name", name: "Name 2", type: "text" }), 409, "key_taken");
    expectError(await call(consoleCaller(viewer), "POST", "crm/properties", { expectedSchemaVersion: detail.schemaVersion, name: "X", type: "text" }), 403, "base_forbidden");

    const scoreView = await createView({ name: "Scored", columns: ["name", "score"], query: { filter: { prop: "score", op: "contains", value: "1" }, sort: [] } });
    expect(expectOk(await call(consoleCaller(owner), "POST", `crm/views/${scoreView.id}/query`, {})).rows.map((r: J) => r.values.name)).toEqual(["Acme"]);

    detail = expectOk(await call(consoleCaller(owner), "GET", "crm"));
    const dryRun = expectOk(await call(consoleCaller(owner), "PATCH", "crm/properties/score", { expectedSchemaVersion: detail.schemaVersion, type: "number" }));
    expect(dryRun.report).toMatchObject({ dryRun: true, converted: 1, cleared: 1 });
    expect(dryRun.report.dependents.views.map((v: J) => v.id)).toContain(scoreView.id);
    expect(dryRun.property.type).toBe("text");
    expect(dryRun.base.schemaVersion).toBe(detail.schemaVersion);

    const migrated = expectOk(
      await call(consoleCaller(owner), "PATCH", "crm/properties/score", { expectedSchemaVersion: detail.schemaVersion, type: "number", confirm: true }),
    );
    expect(migrated.property.type).toBe("number");
    expect(migrated.base.schemaVersion).toBe(detail.schemaVersion + 1);
    const r1 = expectOk(await call(consoleCaller(owner), "GET", `crm/rows/${rowId("r1")}`));
    expect(r1.row.values.score).toBe(10);
    const r2 = expectOk(await call(consoleCaller(owner), "GET", `crm/rows/${rowId("r2")}`));
    expect(r2.row.values.score).toBeUndefined();
    // A filter on a property whose type changed makes the view invalid.
    expectError(await call(consoleCaller(owner), "POST", `crm/views/${scoreView.id}/query`, {}), 409, "view_invalid");
    const listed = expectOk(await call(consoleCaller(owner), "GET", `crm/views/${scoreView.id}`)).view;
    expect(listed.valid).toBe(false);

    // Adding required reports rows without a value.
    const required = expectOk(
      await call(consoleCaller(owner), "PATCH", "crm/properties/amount", { expectedSchemaVersion: migrated.base.schemaVersion, required: true }),
    );
    expect(required.report.missing).toBeGreaterThanOrEqual(2);
    expectOk(await call(consoleCaller(owner), "PATCH", "crm/properties/amount", { expectedSchemaVersion: required.base.schemaVersion, required: false }));
  });

  test("a view referencing a deleted property is view_invalid until it is restored", async () => {
    const notesView = await createView({
      name: "Notes",
      columns: ["name", "notes"],
      access: { read: [{ kind: "project_role", minRole: "viewer" }] },
    });
    expect(expectOk(await call(consoleCaller(viewer), "POST", `crm/views/${notesView.id}/query`, {})).rows.length).toBeGreaterThan(0);
    let schemaVersion = expectOk(await call(consoleCaller(owner), "GET", "crm")).schemaVersion;
    const dryRun = expectOk(await call(consoleCaller(owner), "POST", "crm/properties/notes/delete", { expectedSchemaVersion: schemaVersion }));
    expect(dryRun.report.dryRun).toBe(true);
    expect(dryRun.report.dependents.views.map((v: J) => v.id)).toContain(notesView.id);
    expect(dryRun.property.deletedAt).toBeNull();
    const deleted = expectOk(await call(consoleCaller(owner), "POST", "crm/properties/notes/delete", { expectedSchemaVersion: schemaVersion, confirm: true }));
    expect(deleted.property.deletedAt).toBeString();
    schemaVersion = deleted.base.schemaVersion;
    const invalid = await call(consoleCaller(viewer), "POST", `crm/views/${notesView.id}/query`, {});
    expectError(invalid, 409, "view_invalid");
    expect(invalid.body.rows).toBeUndefined();
    expect(JSON.stringify(invalid.body)).not.toContain("n1");
    expect(expectOk(await call(consoleCaller(viewer), "GET", `crm/views/${notesView.id}`)).valid).toBe(false);
    expectError(await call(consoleCaller(owner), "POST", "crm/rows/query", { filter: { prop: "notes", op: "eq", value: "n1" } }), 400, "unknown_property");
    const restored = expectOk(await call(consoleCaller(owner), "POST", `crm/properties/${deleted.property.id}/restore`, { expectedSchemaVersion: schemaVersion }));
    expect(restored.property.deletedAt).toBeNull();
    expect(expectOk(await call(consoleCaller(viewer), "POST", `crm/views/${notesView.id}/query`, {})).rows.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Ravi Pages

  test("Pages read and write only through page_viewer grants for their site", async () => {
    const pageView = await createView({
      name: "Public leads",
      columns: ["name", "stage"],
      query: { filter: { prop: "stage", op: "eq", value: "Lead" }, sort: [] },
      access: { read: [{ kind: "page_viewer", siteId: siteA }], write: { principals: [{ kind: "page_viewer", siteId: siteA }], columns: ["stage"], allowEscape: true } },
    });
    const pageViewer = pageCaller(viewer, siteA);
    const described = expectOk(await attempt(() => describeViewForCaller(pageViewer, { projectId: projectA.id, viewId: pageView.id })));
    expect(described.view).toBeUndefined();
    expect(described.columns.map((c: J) => c.key)).toEqual(["name", "stage"]);
    const rows = expectOk(await attempt(() => queryViewForCaller(pageViewer, { projectId: projectA.id, viewId: pageView.id, limit: 500 })));
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.values.stage).toBe(stageIds.Lead);

    expectError(await attempt(() => describeViewForCaller(pageCaller(viewer, siteB), { projectId: projectA.id, viewId: pageView.id })), 404, "not_found");
    expectError(await attempt(() => describeViewForCaller(pageViewer, { projectId: projectA.id, viewId: views.mine })), 404, "not_found");
    expectError(await attempt(() => describeViewForCaller(pageCaller(owner, siteA), { projectId: projectA.id, viewId: views.mine })), 404, "not_found");
    expectError(await attempt(() => describeViewForCaller(pageViewer, { projectId: projectB.id, viewId: pageView.id })), 404, "not_found");
    expectError(await attempt(() => chartDataForCaller(pageViewer, { projectId: projectA.id, chartId: views.chart })), 404, "not_found");
    expectError(
      await attempt(() => createRowThroughViewForCaller(pageViewer, { projectId: projectA.id, viewId: pageView.id, values: { name: "x" }, idempotencyKey: idem() })),
      403,
      "base_forbidden",
    );

    const version = await versionOf("r8");
    const updated = expectOk(
      await attempt(() =>
        updateRowThroughViewForCaller(pageViewer, { projectId: projectA.id, viewId: pageView.id, rowId: rowId("r8"), values: { stage: "Won" }, expectedVersion: version, idempotencyKey: idem() }),
      ),
    );
    expect(updated.row.values.stage).toBe(stageIds.Won);
    const [entry] = await db
      .select()
      .from(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.rowId, rowId("r8")), eq(schema.baseRowLedger.version, version + 1)));
    expect(entry).toMatchObject({ surface: "page", actorType: "user", actorId: viewer.id, viewId: pageView.id });
    // Page sessions never manage: direct reads through the Console envelope are not reachable from Pages.
    const pageSession = await call(pageCaller(owner, siteA), "POST", "crm/rows/query", {});
    expectError(pageSession, 403, "base_forbidden");
  });

  // -------------------------------------------------------------------------
  // Events

  test("row events reach subscribed installations only, in the write transaction, without values", async () => {
    expectError(await call(consoleCaller(owner), "POST", "crm/subscriptions", {}), 400, "payload_invalid");
    expectError(await call(cliCaller(viewer), "POST", "crm/subscriptions", {}), 403, "base_forbidden");
    expectError(await call(consoleCaller(viewer), "GET", "crm/subscriptions"), 403, "base_forbidden");
    const first = await call(cliCaller(dev), "POST", "crm/subscriptions", { clientHint: { agentId: "main" } });
    const subscription = expectOk(first, 201);
    expect(subscription).toMatchObject({ localInstallationId: installationId, userId: dev.id, status: "active", installationName: "dev laptop" });
    const again = expectOk(await call(cliCaller(dev), "POST", "crm/subscriptions", {}), 200);
    expect(again.id).toBe(subscription.id);
    await db.insert(schema.baseSubscriptions).values({
      baseId: base.id,
      organizationId: orgId,
      projectId: projectA.id,
      localInstallationId: revokedInstallationId,
      userId: dev.id,
    });
    expect(expectOk(await call(consoleCaller(owner), "GET", "crm/subscriptions")).subscriptions).toHaveLength(2);

    const before = (await inboxItems()).length;
    const created = expectOk(await call(consoleCaller(owner), "POST", "crm/rows", { values: { name: "Event Co", secret: "top-secret" }, idempotencyKey: idem() }), 201);
    const items = (await inboxItems()).slice(before);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      category: "bases",
      eventType: "bases.row.created",
      targetType: "local_installation",
      targetId: installationId,
      dedupeKey: `bases:row:${created.row.rowId}:v1:created:${installationId}:${subscription.id}`,
      sensitivity: "metadata",
    });
    const payload = JSON.stringify(item?.payloadJson);
    for (const forbidden of ["Event Co", "top-secret", "secret", "name"]) expect(payload).not.toContain(forbidden);
    expect(item?.payloadJson).toMatchObject({ baseId: base.id, rowId: created.row.rowId, version: 1, changedPropertyCount: 2, surface: "console", subscriptionId: subscription.id });
    const revoked = await db.select().from(schema.agentInboxItems).where(eq(schema.agentInboxItems.targetId, revokedInstallationId));
    expect(revoked).toHaveLength(0);

    // A rolled-back write emits nothing.
    const count = (await inboxItems()).length;
    expectError(
      await call(consoleCaller(viewer), "PATCH", `crm/views/${views.mine}/rows/${rowId("r12")}`, { values: { stage: "Lost" }, expectedVersion: await versionOf("r12"), idempotencyKey: idem() }),
      409,
      "write_escapes_view",
    );
    expect((await inboxItems()).length).toBe(count);

    // More than 50 rows in one request: one bulk item per installation.
    expectOk(
      await call(consoleCaller(owner), "POST", "crm/rows", {
        rows: Array.from({ length: 51 }, (_, index) => ({ values: { name: `Bulk ${index}`, amount: index } })),
        idempotencyKey: idem("bulk"),
      }),
      201,
    );
    const bulk = (await inboxItems()).slice(count);
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ eventType: "bases.rows.bulk_changed" });
    expect(bulk[0]?.payloadJson).toMatchObject({ rowCount: 51 });

    const revokedSub = expectOk(await call(consoleCaller(owner), "POST", `crm/subscriptions/${subscription.id}/revoke`, {}));
    expect(revokedSub.status).toBe("revoked");
    const afterRevoke = (await inboxItems()).length;
    expectOk(await call(consoleCaller(owner), "POST", "crm/rows", { values: { name: "Quiet Co" }, idempotencyKey: idem() }), 201);
    expect((await inboxItems()).length).toBe(afterRevoke);
  });

  // -------------------------------------------------------------------------
  // Lifecycle

  test("row archive, restore, and purge", async () => {
    const label = "r10";
    const archived = expectOk(await call(consoleCaller(owner), "POST", `crm/rows/${rowId(label)}/archive`, { expectedVersion: await versionOf(label) }));
    expect(archived.row.archivedAt).toBeString();
    expectError(await call(consoleCaller(owner), "GET", `crm/rows/${rowId(label)}`), 404, "not_found");
    expect(expectOk(await call(consoleCaller(owner), "GET", `crm/rows/${rowId(label)}`, {}, { query: "includeArchived=1" })).row.archivedAt).toBeString();
    expectError(await call(consoleCaller(owner), "POST", `crm/rows/${rowId(label)}/archive`, {}), 400, "validation_failed");
    const restored = expectOk(await call(consoleCaller(owner), "POST", `crm/rows/${rowId(label)}/restore`, { expectedVersion: await versionOf(label) }));
    expect(restored.row.archivedAt).toBeNull();
    expectError(await call(consoleCaller(owner), "POST", `crm/rows/${rowId(label)}/purge`, {}), 400, "payload_invalid");
    expect(expectOk(await call(consoleCaller(owner), "POST", `crm/rows/${rowId(label)}/purge`, { confirm: true }))).toEqual({ purged: true, rowId: rowId(label) });
    expectError(await call(consoleCaller(owner), "GET", `crm/rows/${rowId(label)}`, {}, { query: "includeArchived=1" }), 404, "not_found");
    const ledger = await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.rowId, rowId(label)));
    expect(ledger.map((entry) => entry.action)).toEqual(["purged"]);
    expect(ledger[0]?.afterJson).toEqual({});
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "bases.row.purged")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.metadataJson)).not.toContain("Kappa");
  });

  test("archived bases are read-only and hidden from non-managers", async () => {
    const summary = expectOk(await call(consoleCaller(owner), "GET", "crm"));
    const archived = expectOk(await call(consoleCaller(owner), "POST", "crm/archive", { expectedVersion: summary.version }));
    expect(archived.status).toBe("archived");
    expect(expectOk(await call(consoleCaller(owner), "GET", "")).bases.map((b: J) => b.slug)).not.toContain("crm");
    expect(expectOk(await call(consoleCaller(owner), "GET", "", {}, { query: "includeArchived=1" })).bases.map((b: J) => b.slug)).toContain("crm");
    expect(expectOk(await call(consoleCaller(viewer), "GET", "", {}, { query: "includeArchived=1" })).bases).toEqual([]);
    expectError(await call(consoleCaller(viewer), "GET", "crm"), 404, "not_found");
    expectError(await call(consoleCaller(owner), "POST", "crm/rows", { values: { name: "x" }, idempotencyKey: idem() }), 409, "base_archived");
    expectError(await call(consoleCaller(owner), "PATCH", "crm", { expectedVersion: archived.version, name: "x" }), 409, "base_archived");
    expect(expectOk(await call(consoleCaller(owner), "POST", "crm/rows/query", { limit: 1 })).rows).toHaveLength(1);
    expectError(await call(consoleCaller(owner), "POST", "crm/restore", { expectedVersion: summary.version }), 409, "version_conflict");
    expect(expectOk(await call(consoleCaller(owner), "POST", "crm/restore", { expectedVersion: archived.version })).status).toBe("active");

    // An archived project makes its bases read-only.
    expectOk(await call(consoleCaller(owner), "POST", "", { slug: "b1", name: "B1", properties: [{ key: "name", name: "Name", type: "text" }] }, { project: projectB.slug }), 201);
    await db.update(schema.projects).set({ status: "archived" }).where(eq(schema.projects.id, projectB.id));
    expectError(await call(consoleCaller(owner), "POST", "b1/rows", { values: { name: "x" }, idempotencyKey: idem() }, { project: projectB.slug }), 409, "base_archived");
    expectError(await call(consoleCaller(owner), "POST", "", { name: "B2" }, { project: projectB.slug }), 409, "base_archived");
    expect(expectOk(await call(consoleCaller(owner), "GET", "b1", {}, { project: projectB.slug })).slug).toBe("b1");
  });

  test("audit events record base, property, view, chart, and subscription mutations without values", async () => {
    const rows = await db.select({ action: schema.auditEvents.action, metadata: schema.auditEvents.metadataJson }).from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, orgId));
    const actions = new Set(rows.map((row) => row.action));
    for (const action of [
      "bases.base.created",
      "bases.base.archived",
      "bases.base.restored",
      "bases.property.created",
      "bases.property.migrated",
      "bases.property.deleted",
      "bases.property.restored",
      "bases.view.created",
      "bases.view.updated",
      "bases.chart.created",
      "bases.subscription.created",
      "bases.subscription.revoked",
      "bases.row.purged",
    ]) {
      expect(actions).toContain(action);
    }
    expect(JSON.stringify(rows)).not.toContain("top-secret");
    expect(rows.some((row) => row.action.startsWith("bases.row.") && row.action !== "bases.row.purged")).toBe(false);
  });
});
