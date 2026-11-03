import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { basesPolicyFixture, basesCliFixture } from "../../../../tests/review/bases-policy-fixture";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import { basesCallerForPagesViewer, basesCallerFromCliAuth, basesCallerFromConsoleWorkspace, type BasesCaller } from "./context";
import { handleBasesRequest } from "./http";
import { runBasesTick } from "./tick";

// H1/H2 rules: approval and agent columns, view-as, search, the version
// fingerprint, filtered subscriptions, create idempotency, activity, the
// base_operations cleanup, and agent attribution in the ledger. Runs only
// with BASES_TEST_DATABASE_URL (and DATABASE_URL); creates and deletes its
// own organization, users, project, site, and installation.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const project = { id: randomUUID(), slug: `bases-wf-${suffix}` };
const siteId = randomUUID();
const installationId = randomUUID();

const makeUser = (label: string, orgRole: TestUser["orgRole"]): TestUser => ({
  id: randomUUID(),
  email: `bases-wf-${suffix}-${label}@example.test`,
  orgRole,
});
const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const admin = makeUser("admin", "viewer");
const viewer = makeUser("viewer", "viewer");
const outsider = makeUser("outsider", "viewer");
const stranger = makeUser("stranger", "viewer");
const MEMBERS = [owner, dev, admin, viewer, outsider];
const USERS = [...MEMBERS, stranger];
let cliSession: Awaited<ReturnType<typeof basesCliFixture>>;

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

function cliCaller(user: TestUser, hint?: unknown): BasesCaller {
  return basesCallerFromCliAuth(
    {
      user: { id: user.id, primaryEmail: user.email },
      organization: { id: orgId },
      membership: { role: user.orgRole },
      localInstallation: { id: installationId },
      ...cliSession(user.id),
    } as unknown as Parameters<typeof basesCallerFromCliAuth>[0],
    randomUUID(),
    hint,
  );
}

function pageCaller(user: TestUser): BasesCaller {
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

async function call(caller: BasesCaller, method: string, path: string, body: unknown = {}, options: { query?: string; idempotencyKey?: string } = {}): Promise<Res> {
  try {
    const result = await handleBasesRequest({
      caller,
      workspace: null,
      method,
      projectRef: project.slug,
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

const asOwner = () => consoleCaller(owner);

async function createBase(slug: string, properties: unknown[]) {
  return expectOk(await call(asOwner(), "POST", "", { slug, name: slug, properties }), 201);
}

async function createView(slug: string, body: Record<string, unknown>) {
  return expectOk(await call(asOwner(), "POST", `${slug}/views`, body), 201);
}

async function createRow(slug: string, values: Record<string, unknown>, caller = asOwner()) {
  return expectOk(await call(caller, "POST", `${slug}/rows`, { values, idempotencyKey: idem("row") }), 201).row;
}

async function getRow(slug: string, rowId: string) {
  return expectOk(await call(asOwner(), "GET", `${slug}/rows/${rowId}`)).row;
}

async function inboxItems(baseId: string) {
  return db
    .select()
    .from(schema.agentInboxItems)
    .where(and(eq(schema.agentInboxItems.organizationId, orgId), sql`${schema.agentInboxItems.payloadJson} ->> 'baseId' = ${baseId}`));
}

const READ_ALL = [{ kind: "project_role", minRole: "viewer" }];

describeDb("bases workflow (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `bases-wf-${suffix}`, name: "Bases workflow test" }]);
    await db.insert(schema.organizationMemberships).values(MEMBERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([{ id: project.id, organizationId: orgId, slug: project.slug, name: "Workflow" }]);
    await db.insert(schema.projectMemberships).values([
      { projectId: project.id, userId: admin.id, role: "project_admin" },
      { projectId: project.id, userId: viewer.id, role: "viewer" },
    ]);
    await db.insert(schema.pageSites).values([
      { id: siteId, organizationId: orgId, projectId: project.id, slug: `bwf-${suffix}`, defaultHostname: `bwf-${suffix}.ravi.page.test` },
    ]);
    await db.insert(schema.localInstallations).values([{ id: installationId, organizationId: orgId, userId: dev.id, name: "dev laptop" }]);
    cliSession = await basesCliFixture(orgId, installationId, [dev.id, viewer.id]);
    await basesPolicyFixture(orgId, owner.id, [{ projectId: project.id, managers: [owner.id, dev.id, admin.id],
      readers: [viewer.id], viewWriters: [viewer.id], installations: [installationId] }]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  // -------------------------------------------------------------------------
  // Approval

  test("approval config is validated and returned with keys", async () => {
    const base = await createBase("deals", [
      { key: "name", name: "Name", type: "text" },
      { key: "amount", name: "Amount", type: "number" },
      { key: "review", name: "Review", type: "approval", config: { approvers: [{ kind: "project_role", minRole: "project_admin" }], resetOn: ["amount"] } },
      { key: "signoff", name: "Sign-off", type: "approval", config: { approvers: [{ kind: "user", userId: viewer.id }] } },
    ]);
    const review = base.properties.find((p: J) => p.key === "review");
    expect(review.config).toEqual({ approvers: [{ kind: "project_role", minRole: "project_admin" }], resetOn: ["amount"] });
    const v = base.schemaVersion;
    const bad = async (definition: Record<string, unknown>) =>
      expectError(await call(asOwner(), "POST", "deals/properties", { expectedSchemaVersion: v, ...definition }), 400, "validation_failed");
    await bad({ key: "self", name: "Self", type: "approval", config: { approvers: [{ kind: "project_role", minRole: "viewer" }], resetOn: ["self"] } });
    await bad({ key: "chain", name: "Chain", type: "approval", config: { approvers: [{ kind: "project_role", minRole: "viewer" }], resetOn: ["review"] } });
    await bad({ key: "nobody", name: "Nobody", type: "approval" });
    await bad({ key: "ext", name: "Ext", type: "approval", config: { approvers: [{ kind: "user", userId: stranger.id }] } });
    await bad({ key: "req", name: "Req", type: "approval", required: true, config: { approvers: [{ kind: "project_role", minRole: "viewer" }] } });
    await bad({ key: "mixed", name: "Mixed", type: "text", config: { approvers: [{ kind: "project_role", minRole: "viewer" }] } });
    expectError(await call(asOwner(), "PATCH", "deals/properties/amount", { expectedSchemaVersion: v, type: "approval", confirm: true }), 400, "validation_failed");
    expectError(await call(asOwner(), "PATCH", "deals/properties/review", { expectedSchemaVersion: v, type: "text", confirm: true }), 400, "validation_failed");
  });

  test("approval decisions are refused for non-approvers on the console, the CLI, and Pages", async () => {
    const view = await createView("deals", {
      name: "Approvals",
      columns: ["name", "amount", "review", "signoff"],
      access: { read: READ_ALL, write: { principals: READ_ALL, columns: ["amount", "review", "signoff"] } },
    });
    const pageView = await createView("deals", {
      name: "Approvals page",
      columns: ["name", "review"],
      access: { read: [{ kind: "page_viewer", siteId }], write: { principals: [{ kind: "page_viewer", siteId }], columns: ["review"] } },
    });
    expect(expectOk(await call(consoleCaller(viewer), "GET", `deals/views/${view.id}`)).capabilities.approve).toEqual(["signoff"]);
    expect(expectOk(await call(consoleCaller(admin), "GET", `deals/views/${view.id}`)).capabilities.approve).toEqual(["review"]);

    // Anyone who may write the column may ask; the server records who and when.
    const row = await createRow("deals", { name: "Acme", amount: 10, review: "pending" });
    expect(row.values.review).toMatchObject({ state: "pending", requestedBy: owner.id, decidedBy: null });

    const decide = (caller: BasesCaller, path: string, values: Record<string, unknown>, version: number) =>
      call(caller, "PATCH", path, { values, expectedVersion: version, idempotencyKey: idem("decide") });
    let version = row.version;
    const viaView = `deals/views/${view.id}/rows/${row.rowId}`;
    expectError(await decide(consoleCaller(viewer), viaView, { review: { state: "approved" } }, version), 403, "approval_forbidden");
    expectError(await decide(cliCaller(viewer), viaView, { review: { state: "approved" } }, version), 403, "approval_forbidden");
    expectError(await decide(pageCaller(viewer), `deals/views/${pageView.id}/rows/${row.rowId}`, { review: { state: "rejected" } }, version), 403, "approval_forbidden");
    // The owner manages the base but is no approver of `signoff` (a user principal).
    expectError(await decide(asOwner(), `deals/rows/${row.rowId}`, { signoff: { state: "approved" } }, version), 403, "approval_forbidden");
    expect((await getRow("deals", row.rowId)).version).toBe(version);

    // Pages callers decide with their real project role.
    const approved = expectOk(await decide(pageCaller(admin), `deals/views/${pageView.id}/rows/${row.rowId}`, { review: { state: "approved", note: "ok" } }, version));
    expect(approved.row.values.review).toMatchObject({ state: "approved", requestedBy: owner.id, decidedBy: admin.id, note: "ok" });
    version = approved.row.version;
    const signed = expectOk(await decide(consoleCaller(viewer), viaView, { signoff: { state: "rejected" } }, version));
    expect(signed.row.values.signoff).toMatchObject({ state: "rejected", decidedBy: viewer.id });
    expect(signed.users[viewer.id]).toBeDefined();
    version = signed.row.version;

    // resetOn: changing `amount` sends the decided review back to pending in the same write.
    const changed = expectOk(await decide(consoleCaller(viewer), viaView, { amount: 20 }, version));
    expect(changed.row.version).toBe(version + 1);
    expect(changed.row.values.review).toMatchObject({ state: "pending", requestedBy: viewer.id, decidedBy: null, note: null });
    expect(changed.row.values.signoff).toMatchObject({ state: "rejected" });

    const pending = expectOk(await call(asOwner(), "POST", "deals/rows/query", { filter: { prop: "review", op: "state_in", value: ["pending"] } }));
    expect(pending.rows.map((r: J) => r.rowId)).toEqual([row.rowId]);
    const grouped = expectOk(await call(asOwner(), "POST", "deals/rows/aggregate", { groupBy: [{ prop: "review" }], aggregate: [{ op: "count", as: "n" }] }));
    expect(grouped.groups).toEqual([{ keys: { review: "pending" }, values: { n: 1 } }]);
  });

  test("resetOn: echoing the stored approval value with a resetOn change still resets it", async () => {
    const view = await createView("deals", {
      name: "Echo",
      columns: ["name", "amount", "review"],
      access: { read: READ_ALL, write: { principals: READ_ALL, columns: ["amount", "review"] } },
    });
    const subscription = expectOk(await call(cliCaller(dev), "POST", "deals/subscriptions", { events: ["approval.requested"] }), 201);
    const row = await createRow("deals", { name: "Echo", amount: 10, review: "pending" });
    const viaView = `deals/views/${view.id}/rows/${row.rowId}`;
    const write = (caller: BasesCaller, values: Record<string, unknown>, version: number) =>
      call(caller, "PATCH", viaView, { values, expectedVersion: version, idempotencyKey: idem("echo") });
    const approved = expectOk(await write(consoleCaller(admin), { review: { state: "approved", note: "ok" } }, row.version)).row;
    expect(approved.values.review).toMatchObject({ state: "approved", decidedBy: admin.id });

    // The viewer may write `amount` but is no approver of `review`: sending the stored
    // value back alongside the change must not keep the decision.
    const changed = expectOk(await write(consoleCaller(viewer), { amount: 30, review: approved.values.review }, approved.version)).row;
    expect(changed.version).toBe(approved.version + 1);
    expect(changed.values.amount).toBe(30);
    expect(changed.values.review).toMatchObject({ state: "pending", requestedBy: viewer.id, decidedBy: null, note: null });

    const base = expectOk(await call(asOwner(), "GET", "deals"));
    const requested = (await inboxItems(base.id)).filter(
      (item) =>
        item.sourceId === row.rowId &&
        item.eventType === "bases.approval.requested" &&
        (item.payloadJson as J).subscriptionId === subscription.id,
    );
    expect(requested.map((item) => (item.payloadJson as J).version).sort()).toEqual([row.version, changed.version]);
  });

  test("approval columns are refused in write.set", async () => {
    expectError(
      await call(asOwner(), "POST", "deals/views", {
        name: "Preset",
        columns: ["name"],
        access: { read: READ_ALL, write: { principals: READ_ALL, columns: ["name"], create: true, set: { review: "pending" } } },
      }),
      400,
      "validation_failed",
    );
  });

  // -------------------------------------------------------------------------
  // Agent

  test("agent values are never writable through rows or views", async () => {
    await createBase("leads", [
      { key: "name", name: "Name", type: "text" },
      { key: "amount", name: "Amount", type: "number" },
      { key: "summary", name: "Summary", type: "agent", config: { instructions: "Resuma o lead", inputs: ["name", "amount"], output: "text", agent: "resumidor" } },
    ]);
    const created = expectError(await call(asOwner(), "POST", "leads/rows", { values: { name: "A", summary: "forged" }, idempotencyKey: idem() }), 400, "validation_failed");
    expect(created.fieldErrors.summary).toBe("agent_readonly");
    const row = await createRow("leads", { name: "A", amount: 1 });
    expect(row.values.summary).toMatchObject({ state: "pending", value: null });
    const updated = expectError(
      await call(asOwner(), "PATCH", `leads/rows/${row.rowId}`, { values: { summary: { state: "done", value: "x" } }, expectedVersion: row.version, idempotencyKey: idem() }),
      400,
      "validation_failed",
    );
    expect(updated.fieldErrors.summary).toBe("agent_readonly");
    for (const write of [
      { principals: READ_ALL, columns: ["summary"] },
      { principals: READ_ALL, columns: ["name"], create: true, set: { summary: "x" } },
    ]) {
      expectError(await call(asOwner(), "POST", "leads/views", { name: "W", columns: ["name", "summary"], access: { read: READ_ALL, write } }), 400, "validation_failed");
    }
    const open = await createView("leads", { name: "Open", columns: ["name", "summary"], access: { read: READ_ALL, write: { principals: READ_ALL, columns: ["name"] } } });
    expect(expectOk(await call(asOwner(), "GET", `leads/views/${open.id}`)).capabilities.writeColumns).not.toContain("summary");
    const viaView = await call(asOwner(), "PATCH", `leads/views/${open.id}/rows/${row.rowId}`, {
      values: { summary: "x" },
      expectedVersion: row.version,
      idempotencyKey: idem(),
    });
    expect(viaView.status).toBe(400);
    // Public descriptors never carry instructions or inputs.
    const column = expectOk(await call(consoleCaller(viewer), "GET", `leads/views/${open.id}`)).columns.find((c: J) => c.key === "summary");
    expect(column.config).toEqual({ output: "text", agent: "resumidor" });
  });

  test("agents fill with the current inputs hash; stale fills are 409; rerun re-requests", async () => {
    const detail = expectOk(await call(asOwner(), "GET", "leads"));
    const sub = expectOk(await call(cliCaller(dev), "POST", "leads/subscriptions", {}), 201);
    expect(sub).toMatchObject({ viewId: null, properties: [], events: [] });
    const row = await createRow("leads", { name: "Beta", amount: 5 });
    const hash = row.values.summary.inputsHash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    let items = await inboxItems(detail.id);
    expect(items.filter((i) => i.sourceId === row.rowId).map((i) => i.eventType).sort()).toEqual(["bases.agent.requested", "bases.row.created"]);
    expect(items.find((i) => i.eventType === "bases.agent.requested" && i.sourceId === row.rowId)?.payloadJson).toMatchObject({ inputsHash: hash });

    const fill = (body: Record<string, unknown>, key = idem("fill"), caller = cliCaller(dev)) =>
      call(caller, "POST", `leads/rows/${row.rowId}/agent/summary`, body, { idempotencyKey: key });
    const stale = expectError(await fill({ inputsHash: "0000000000000000", value: "x" }), 409, "agent_stale");
    expect(stale.inputsHash).toBe(hash);
    expectError(await call(cliCaller(dev), "POST", `leads/rows/${row.rowId}/agent/summary`, { inputsHash: hash, value: "x" }), 400, "validation_failed");
    expectError(await fill({ inputsHash: hash, value: "x" }, idem(), consoleCaller(viewer)), 403, "base_forbidden");

    const key = idem("fill");
    const filled = expectOk(await fill({ inputsHash: hash, value: "Resumo" }, key));
    expect(filled.row.version).toBe(row.version + 1);
    expect(filled.row.values.summary).toMatchObject({ state: "done", value: "Resumo", error: null, inputsHash: hash });
    const replay = expectOk(await fill({ inputsHash: hash, value: "Resumo" }, key));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.row.version).toBe(filled.row.version);
    items = await inboxItems(detail.id);
    const fillItems = items.filter((i) => i.sourceId === row.rowId && (i.payloadJson as J).version === filled.row.version);
    expect(fillItems.map((i) => i.eventType)).toEqual(["bases.row.updated"]);

    // A change to an input re-requests; the previous value stays visible while pending.
    const edited = expectOk(
      await call(asOwner(), "PATCH", `leads/rows/${row.rowId}`, { values: { amount: 6 }, expectedVersion: filled.row.version, idempotencyKey: idem() }),
    );
    expect(edited.row.values.summary).toMatchObject({ state: "pending", value: "Resumo" });
    expect(edited.row.values.summary.inputsHash).not.toBe(hash);
    // A change to something else does not.
    const renamedOnly = expectOk(
      await call(asOwner(), "PATCH", `leads/rows/${row.rowId}`, { body: "notes", expectedVersion: edited.row.version, idempotencyKey: idem() }),
    );
    expect(renamedOnly.row.values.summary.inputsHash).toBe(edited.row.values.summary.inputsHash);

    const errored = expectOk(await fill({ inputsHash: edited.row.values.summary.inputsHash, error: "timeout" }));
    expect(errored.row.values.summary).toMatchObject({ state: "error", value: "Resumo", error: "timeout" });
    const rerun = expectOk(await call(cliCaller(dev), "POST", `leads/rows/${row.rowId}/agent/summary/rerun`, {}));
    expect(rerun.row.values.summary).toMatchObject({ state: "pending", value: "Resumo", error: null });
    items = await inboxItems(detail.id);
    expect(items.some((i) => i.eventType === "bases.agent.requested" && (i.payloadJson as J).version === rerun.row.version)).toBe(true);

    const pendingRows = expectOk(await call(asOwner(), "POST", "leads/rows/query", { filter: { prop: "summary", op: "state_in", value: "pending" } }));
    expect(pendingRows.rows.map((r: J) => r.rowId)).toContain(row.rowId);
    expectError(await call(cliCaller(dev), "POST", `leads/rows/${row.rowId}/agent/name`, { inputsHash: hash, value: "x" }, { idempotencyKey: idem() }), 400, "validation_failed");
  });

  test("a new agent column on a base with rows emits one backfill per subscription and leaves rows empty", async () => {
    const detail = expectOk(await call(asOwner(), "GET", "leads"));
    const rows = expectOk(await call(asOwner(), "POST", "leads/rows/query", {})).rows;
    const created = expectOk(
      await call(asOwner(), "POST", "leads/properties", {
        expectedSchemaVersion: detail.schemaVersion,
        key: "tier",
        name: "Tier",
        type: "agent",
        config: { instructions: "Classifique", inputs: ["amount"], output: "select", options: [{ name: "Alto" }, { name: "Baixo" }] },
      }),
    );
    expect(created.property.config.inputs).toEqual(["amount"]);
    const backfills = (await inboxItems(detail.id)).filter((i) => i.eventType === "bases.agent.backfill");
    expect(backfills).toHaveLength(1);
    const subscriptions = expectOk(await call(asOwner(), "GET", "leads/subscriptions")).subscriptions;
    expect(subscriptions).toHaveLength(1);
    expect(backfills[0]?.payloadJson).toEqual({
      subscriptionId: subscriptions[0].id,
      baseId: detail.id,
      baseSlug: "leads",
      projectId: project.id,
      propertyId: created.property.id,
      rowCount: rows.length,
      schemaVersion: created.base.schemaVersion,
    });
    expect((await getRow("leads", rows[0].rowId)).values.tier).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // View-as, search, version

  test("view-as is for managers on the console and CLI only, evaluated as the member", async () => {
    await createBase("tasks", [
      { key: "title", name: "Title", type: "text" },
      { key: "secret", name: "Secret", type: "text" },
      { key: "owner", name: "Owner", type: "person" },
    ]);
    const mine = await createView("tasks", {
      name: "Mine",
      columns: ["title", "owner"],
      query: { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" }, sort: [] },
      access: { read: READ_ALL },
    });
    const pageMine = await createView("tasks", { name: "Page", columns: ["title"], access: { read: [{ kind: "page_viewer", siteId }] } });
    const viewerRow = await createRow("tasks", { title: "Ana task", secret: "acme-secret", owner: [viewer.id] });
    const adminRow = await createRow("tasks", { title: "Acme admin", secret: "x", owner: [admin.id] });

    const asViewer = expectOk(await call(asOwner(), "POST", `tasks/views/${mine.id}/query`, { asUserId: viewer.id }));
    expect(asViewer.viewingAs).toEqual({ userId: viewer.id, admitted: true });
    expect(asViewer.rows.map((r: J) => r.rowId)).toEqual([viewerRow.rowId]);
    const viaCli = expectOk(await call(cliCaller(dev), "POST", `tasks/views/${mine.id}/query`, { asUserId: admin.id }));
    expect(viaCli.rows.map((r: J) => r.rowId)).toEqual([adminRow.rowId]);
    const notAdmitted = expectOk(await call(asOwner(), "POST", `tasks/views/${mine.id}/query`, { asUserId: outsider.id }));
    expect(notAdmitted).toMatchObject({ rows: [], viewingAs: { userId: outsider.id, admitted: false } });
    expectError(await call(asOwner(), "POST", `tasks/views/${mine.id}/query`, { asUserId: stranger.id }), 400, "validation_failed");
    expectError(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/query`, { asUserId: admin.id }), 403, "base_forbidden");
    expectError(await call(pageCaller(owner), "POST", `tasks/views/${pageMine.id}/query`, { asUserId: viewer.id }), 403, "base_forbidden");
    expectError(await call(asOwner(), "POST", "tasks/rows/query", { asUserId: viewer.id }), 400, "payload_invalid");

    const one = expectOk(await call(asOwner(), "GET", `tasks/views/${mine.id}/rows/${viewerRow.rowId}`, {}, { query: `asUserId=${viewer.id}` }));
    expect(one.viewingAs).toEqual({ userId: viewer.id, admitted: true });
    expectError(await call(asOwner(), "GET", `tasks/views/${mine.id}/rows/${adminRow.rowId}`, {}, { query: `asUserId=${viewer.id}` }), 404, "not_found");
    expectError(await call(consoleCaller(viewer), "GET", `tasks/views/${mine.id}/rows/${viewerRow.rowId}`, {}, { query: `asUserId=${admin.id}` }), 403, "base_forbidden");

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "bases.view.viewed_as")));
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((audit) => audit.targetId === mine.id)).toBe(true);
  });

  test("search ORs text-like columns the caller may reference", async () => {
    const all = expectOk(await call(asOwner(), "POST", "tasks/rows/query", { search: "ACME" }));
    expect(all.rows).toHaveLength(2);
    const views = expectOk(await call(asOwner(), "GET", "tasks/views")).views;
    const mine = views.find((v: J) => v.name === "Mine");
    // Through the view `secret` is not projected: "secret" only matches it.
    expect(expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/query`, { search: "acme-secret" })).rows).toEqual([]);
    expect(expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/query`, { search: "ana" })).rows).toHaveLength(1);
    expectError(await call(asOwner(), "POST", "tasks/rows/query", { search: "" }), 400);
  });

  test("the version fingerprint changes with the rows the caller sees", async () => {
    const views = expectOk(await call(asOwner(), "GET", "tasks/views")).views;
    const mine = views.find((v: J) => v.name === "Mine");
    const first = expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/version`, {}));
    expect(first.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/version`, {})).fingerprint).toBe(first.fingerprint);
    // A row the viewer does not see leaves the viewer's fingerprint alone.
    await createRow("tasks", { title: "Other", owner: [admin.id] });
    expect(expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/version`, {})).fingerprint).toBe(first.fingerprint);
    await createRow("tasks", { title: "Mine too", owner: [viewer.id] });
    expect(expectOk(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/version`, {})).fingerprint).not.toBe(first.fingerprint);
    expectError(await call(consoleCaller(outsider), "POST", `tasks/views/${mine.id}/version`, {}), 404, "not_found");
    expectError(await call(consoleCaller(viewer), "POST", `tasks/views/${mine.id}/version`, { filter: null }), 400);
  });

  // -------------------------------------------------------------------------
  // Filtered subscriptions

  test("filtered subscriptions deliver only matching events, properties, and rows the subscriber sees through the view", async () => {
    const base = await createBase("tickets", [
      { key: "title", name: "Title", type: "text" },
      { key: "status", name: "Status", type: "select", config: { options: [{ name: "Open" }, { name: "Won" }] } },
      { key: "owner", name: "Owner", type: "person" },
    ]);
    const mine = await createView("tickets", {
      name: "Mine",
      columns: ["title", "status"],
      query: { filter: { prop: "owner", op: "contains", value: "$viewer.raviUserId" }, sort: [] },
    });
    const all = expectOk(await call(cliCaller(dev), "POST", "tickets/subscriptions", {}), 201);
    const byView = expectOk(await call(cliCaller(dev), "POST", "tickets/subscriptions", { viewId: mine.id, events: ["row.updated", "row.created"] }), 201);
    const byProp = expectOk(await call(cliCaller(dev), "POST", "tickets/subscriptions", { properties: ["status"], events: ["row.updated"] }), 201);
    expect(byView).toMatchObject({ viewId: mine.id, properties: [], events: ["row.created", "row.updated"] });
    expect(byProp).toMatchObject({ viewId: null, properties: ["status"], events: ["row.updated"] });
    const again = expectOk(await call(cliCaller(dev), "POST", "tickets/subscriptions", { events: ["row.created", "row.updated"], viewId: mine.id.toUpperCase() }));
    expect(again.id).toBe(byView.id);
    expect(expectOk(await call(cliCaller(dev), "POST", "tickets/subscriptions", {})).id).toBe(all.id);
    const other = expectOk(await call(asOwner(), "GET", "deals/views")).views[0];
    expectError(await call(cliCaller(dev), "POST", "tickets/subscriptions", { viewId: other.id }), 400, "validation_failed");
    expectError(await call(cliCaller(dev), "POST", "tickets/subscriptions", { properties: ["nope"] }), 400, "validation_failed");

    const devRow = await createRow("tickets", { title: "Dev", owner: [dev.id] });
    const viewerRow = await createRow("tickets", { title: "Viewer", owner: [viewer.id] });
    let v = devRow.version;
    v = expectOk(await call(asOwner(), "PATCH", `tickets/rows/${devRow.rowId}`, { values: { title: "Dev 2" }, expectedVersion: v, idempotencyKey: idem() })).row.version;
    v = expectOk(await call(asOwner(), "PATCH", `tickets/rows/${devRow.rowId}`, { values: { status: "Won" }, expectedVersion: v, idempotencyKey: idem() })).row.version;
    const vv = expectOk(
      await call(asOwner(), "PATCH", `tickets/rows/${viewerRow.rowId}`, { values: { status: "Won" }, expectedVersion: viewerRow.version, idempotencyKey: idem() }),
    ).row.version;
    await call(asOwner(), "POST", `tickets/rows/${devRow.rowId}/archive`, { expectedVersion: v });

    const items = await inboxItems(base.id);
    const of = (subscriptionId: string | null) =>
      items
        .filter((i) => ((i.payloadJson as J).subscriptionId ?? null) === subscriptionId)
        .map((i) => `${i.sourceId === devRow.rowId ? "dev" : "viewer"}:${i.eventType}:v${(i.payloadJson as J).version}`)
        .sort();
    expect(of(all.id)).toEqual(
      [
        "dev:bases.row.created:v1",
        "dev:bases.row.updated:v2",
        "dev:bases.row.updated:v3",
        "dev:bases.row.archived:v4",
        "viewer:bases.row.created:v1",
        `viewer:bases.row.updated:v${vv}`,
      ].sort(),
    );
    // The view admits rows the subscriber owns: the viewer's row never reaches it.
    expect(of(byView.id)).toEqual(["dev:bases.row.created:v1", "dev:bases.row.updated:v2", "dev:bases.row.updated:v3"]);
    expect(of(byProp.id)).toEqual(["dev:bases.row.updated:v3", `viewer:bases.row.updated:v${vv}`].sort());
    const filtered = items.find((i) => (i.payloadJson as J).subscriptionId === byView.id);
    expect(filtered?.dedupeKey.endsWith(`:${byView.id}`)).toBe(true);

    const listed = expectOk(await call(asOwner(), "GET", "tickets/subscriptions")).subscriptions;
    expect(listed.map((s: J) => s.id).sort()).toEqual([all.id, byView.id, byProp.id].sort());
  });

  // -------------------------------------------------------------------------
  // Create idempotency, activity, cleanup, attribution

  test("creates replay with the same key and refuse a different request", async () => {
    const key = idem("create");
    const body = { slug: "idem", name: "Idem" };
    const first = expectOk(await call(asOwner(), "POST", "", body, { idempotencyKey: key }), 201);
    const replay = expectOk(await call(asOwner(), "POST", "", { ...body, idempotencyKey: key }), 200);
    expect(replay.id).toBe(first.id);
    expectError(await call(asOwner(), "POST", "", { slug: "idem-2", name: "Idem" }, { idempotencyKey: key }), 409, "idempotency_conflict");
    expectError(await call(asOwner(), "POST", "", { slug: "idem-3", name: "Idem" }, { idempotencyKey: "short" }), 400, "validation_failed");

    const propertyKey = idem("prop");
    const property = expectOk(await call(asOwner(), "POST", "idem/properties", { expectedSchemaVersion: first.schemaVersion, key: "note", name: "Note", type: "text", idempotencyKey: propertyKey }));
    // The replay answers even though the schema version moved on.
    const propertyReplay = expectOk(await call(asOwner(), "POST", "idem/properties", { expectedSchemaVersion: first.schemaVersion, key: "note", name: "Note", type: "text", idempotencyKey: propertyKey }));
    expect(propertyReplay.property.id).toBe(property.property.id);

    const viewKey = idem("view");
    const view = expectOk(await call(asOwner(), "POST", "idem/views", { name: "V", columns: ["note"] }, { idempotencyKey: viewKey }), 201);
    expect(expectOk(await call(asOwner(), "POST", "idem/views", { name: "V", columns: ["note"] }, { idempotencyKey: viewKey }), 200).id).toBe(view.id);
    expectError(await call(asOwner(), "POST", "idem/views", { name: "V2", columns: ["note"] }, { idempotencyKey: viewKey }), 409, "idempotency_conflict");

    const chartKey = idem("chart");
    const chartBody = { name: "C", viewId: view.id, spec: { mark: "bar", encoding: { y: { aggregate: "count", type: "quantitative" } } } };
    const chart = expectOk(await call(asOwner(), "POST", "idem/charts", chartBody, { idempotencyKey: chartKey }), 201);
    expect(expectOk(await call(asOwner(), "POST", "idem/charts", chartBody, { idempotencyKey: chartKey }), 200).id).toBe(chart.id);
    expect(expectOk(await call(asOwner(), "GET", "idem/views")).views.filter((v: J) => v.name === "V")).toHaveLength(1);
  });

  test("activity lists the base's own audit events, newest first, for managers", async () => {
    const detail = expectOk(await call(asOwner(), "GET", "tickets"));
    const activity = expectOk(await call(asOwner(), "GET", "tickets/activity"));
    expect(activity.nextCursor).toBeNull();
    const types = activity.events.map((e: J) => e.type);
    expect(types).toContain("bases.base.created");
    expect(types).toContain("bases.subscription.created");
    expect(types.every((t: string) => t.startsWith("bases."))).toBe(true);
    const times = activity.events.map((e: J) => e.t);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(activity.events.find((e: J) => e.type === "bases.base.created")).toMatchObject({ target: detail.id, project: project.slug, actor: owner.id });
    // Another base's events never show up.
    const deals = expectOk(await call(asOwner(), "GET", "deals"));
    expect(activity.events.some((e: J) => e.target === deals.id)).toBe(false);
    expectError(await call(consoleCaller(viewer), "GET", "tickets/activity"), 403, "base_forbidden");
    expectError(await call(asOwner(), "GET", "tickets/activity", {}, { query: "cursor=bad" }), 400, "validation_failed");
  });

  test("the cleanup deletes expired idempotency records only", async () => {
    const base = expectOk(await call(asOwner(), "GET", "tickets"));
    const values = (key: string, expiresAt: Date) => ({
      organizationId: orgId,
      projectId: project.id,
      baseId: base.id,
      sourceKind: "user",
      sourceId: owner.id,
      operation: "console.bases.rows.create",
      idempotencyKey: key,
      requestHash: "h",
      resultJson: {},
      expiresAt,
    });
    const [expired] = await db.insert(schema.baseOperations).values(values(idem("old"), new Date(Date.now() - 60_000))).returning();
    const [live] = await db.insert(schema.baseOperations).values(values(idem("new"), new Date(Date.now() + 60_000))).returning();
    const result = await runBasesTick();
    expect(result.expiredOperations).toBeGreaterThanOrEqual(1);
    const left = await db.select({ id: schema.baseOperations.id }).from(schema.baseOperations).where(inArray(schema.baseOperations.id, [expired!.id, live!.id]));
    expect(left.map((row) => row.id)).toEqual([live!.id]);
  });

  test("the ledger names the agent that wrote for the accountable person", async () => {
    const row = await createRow("tickets", { title: "Agent" });
    const updated = expectOk(
      await call(cliCaller(dev, { agentId: "main", sdk: "ravi" }), "PATCH", `tickets/rows/${row.rowId}`, {
        values: { title: "Agent 2" },
        expectedVersion: row.version,
        idempotencyKey: idem(),
      }),
    );
    const history = expectOk(await call(asOwner(), "GET", `tickets/rows/${row.rowId}/history`));
    const [latest, first] = history.entries;
    expect(latest).toMatchObject({ version: updated.row.version, actorType: "cli", actorId: dev.id, agent: { id: "main", installationId } });
    expect(first.agent).toBeNull();
    const [ledger] = await db
      .select()
      .from(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.rowId, row.rowId), eq(schema.baseRowLedger.version, updated.row.version)));
    expect(ledger).toMatchObject({ agentId: "main", localInstallationId: installationId, actorId: dev.id });
  });
});
