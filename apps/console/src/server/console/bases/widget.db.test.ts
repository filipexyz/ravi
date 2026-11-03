import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { basesPolicyFixture } from "../../../../tests/review/bases-policy-fixture";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import { basesCallerFromConsoleWorkspace, type BasesCaller } from "./context";
import { handleBasesRequest } from "./http";

// `layout.widget` through `handleBasesRequest` (SPEC "Views", CHECKS
// "Views"). Runs only with BASES_TEST_DATABASE_URL (and DATABASE_URL)
// pointing at a Console database with the `widget` Library kind. Creates its
// own organizations, users, projects, and Library items, and deletes them
// afterwards.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectA = { id: randomUUID(), slug: `widgets-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `widgets-b-${suffix}` };

const owner: TestUser = { id: randomUUID(), email: `bases-widget-${suffix}-owner@example.test`, orgRole: "owner" };
const viewer: TestUser = { id: randomUUID(), email: `bases-widget-${suffix}-viewer@example.test`, orgRole: "viewer" };
const USERS = [owner, viewer];

const MANIFEST = JSON.stringify({
  name: "Cartão de pedido",
  description: "Pedido com fase, valor, prazo e capa.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    valor: { type: "number", role: "highlight" },
    fase: { type: "select" },
    prazo: { type: "date" },
    capa: { type: "url", role: "image" },
  },
  variants: ["default", "compact"],
});
const TEMPLATE = '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-field name="valor"></ravi-field></ravi-card>';

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

async function call(user: TestUser, method: string, path: string, body: unknown = {}): Promise<Res> {
  try {
    const result = await handleBasesRequest({
      caller: consoleCaller(user),
      workspace: null,
      method,
      projectRef: projectA.slug,
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

function expectOk(res: Res, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function expectFieldError(res: Res, field: string, message?: string | RegExp) {
  if (res.status !== 400 || res.body?.error !== "validation_failed" || typeof res.body?.fieldErrors?.[field] !== "string") {
    throw new Error(`expected validation_failed on ${field}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (message !== undefined) expect(res.body.fieldErrors[field]).toMatch(message);
}

type ItemSpec = { organizationId?: string; projectId?: string | null; kind?: "skill" | "widget"; slug: string; published?: boolean; archived?: boolean };

/** A Library item written directly: published items get version 1 with `widget.json` and `widget.html` (or `SKILL.md`). */
async function insertItem(spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  const organizationId = spec.organizationId ?? orgId;
  const kind = spec.kind ?? "widget";
  await db.insert(schema.libraryItems).values({
    id,
    organizationId,
    projectId: spec.projectId ?? null,
    kind,
    slug: spec.slug,
    name: spec.slug,
    description: `Test item ${spec.slug}.`,
    createdByUserId: owner.id,
  });
  if (spec.published === false) return id;
  const files =
    kind === "widget"
      ? [
          { path: "widget.html", content: TEMPLATE },
          { path: "widget.json", content: MANIFEST },
        ]
      : [{ path: "SKILL.md", content: "---\nname: test\ndescription: Test.\n---\n" }];
  const [version] = await db
    .insert(schema.libraryVersions)
    .values({
      itemId: id,
      organizationId,
      versionNumber: 1,
      status: "published",
      contentHash: `hash-${id}`,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.content.length, 0),
      publishedAt: new Date(),
      publishedByUserId: owner.id,
    })
    .returning();
  await db.insert(schema.libraryFiles).values(
    files.map((file) => ({ versionId: version!.id, path: file.path, content: file.content, bytes: file.content.length, sha256: `sha-${file.path}` })),
  );
  await db
    .update(schema.libraryItems)
    .set({ currentVersionId: version!.id, currentVersionNumber: 1, publishedAt: new Date(), archivedAt: spec.archived ? new Date() : null })
    .where(eq(schema.libraryItems.id, id));
  return id;
}

describeDb("bases layout.widget (db)", () => {
  const items = {} as Record<"pedido" | "proj" | "otherProject" | "skill" | "archived" | "draft" | "foreign" | "temp", string>;
  let propertyIds: Record<string, string> = {};

  const COLUMNS = ["name", "amount", "stage", "due", "created_time"];
  const board = (widget: unknown, extra: Record<string, unknown> = {}) => ({
    name: `Board ${randomUUID().slice(0, 6)}`,
    columns: COLUMNS,
    layout: { type: "board", groupBy: "stage", widget },
    ...extra,
  });
  const createView = (body: unknown) => call(owner, "POST", "orders/views", body);
  const schemaVersion = async () => expectOk(await call(owner, "GET", "orders")).schemaVersion as number;

  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([
      { id: orgId, slug: `bases-widget-${suffix}`, name: "Bases widget test" },
      { id: otherOrgId, slug: `bases-widget-other-${suffix}`, name: "Other org" },
    ]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([{ projectId: projectA.id, userId: viewer.id, role: "viewer" }]);
    await basesPolicyFixture(orgId, owner.id, [{ projectId: projectA.id, managers: [owner.id], readers: [viewer.id] },
      { projectId: projectB.id, managers: [owner.id] }]);

    items.pedido = await insertItem({ slug: "pedido-card" });
    items.proj = await insertItem({ projectId: projectA.id, slug: "proj-card" });
    items.otherProject = await insertItem({ projectId: projectB.id, slug: "other-card" });
    items.skill = await insertItem({ kind: "skill", slug: "some-skill" });
    items.archived = await insertItem({ slug: "archived-card", archived: true });
    items.draft = await insertItem({ slug: "draft-card", published: false });
    items.foreign = await insertItem({ organizationId: otherOrgId, slug: "foreign-card" });
    items.temp = await insertItem({ slug: "temp-card" });

    const created = expectOk(
      await call(owner, "POST", "", {
        slug: "orders",
        name: "Orders",
        properties: [
          { key: "name", name: "Name", type: "text", required: true },
          { key: "amount", name: "Amount", type: "number" },
          { key: "stage", name: "Stage", type: "select", config: { options: [{ name: "Lead" }, { name: "Won" }] } },
          { key: "cover", name: "Cover", type: "url" },
          { key: "due", name: "Due", type: "date" },
          { key: "notes", name: "Notes", type: "text" },
        ],
      }),
      201,
    );
    propertyIds = Object.fromEntries(created.properties.map((property: J) => [property.key, property.id]));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("saving a binding by ref stores ids, returns keys and the current ref, and audits widgetItemId", async () => {
    const view = expectOk(
      await createView(board({ ref: "org/pedido-card", fields: { titulo: "name", valor: "amount", prazo: "created_time" }, variant: "compact" })),
      201,
    );
    expect(view.layout).toEqual({
      type: "board",
      groupBy: "stage",
      widget: { itemId: items.pedido, ref: "org/pedido-card", fields: { titulo: "name", valor: "amount", prazo: "created_time" }, variant: "compact" },
    });
    expect(view.valid).toBe(true);
    const [stored] = await db.select().from(schema.baseViews).where(eq(schema.baseViews.id, view.id));
    expect(stored!.layoutJson).toEqual({
      type: "board",
      groupBy: propertyIds.stage,
      widget: { itemId: items.pedido, fields: { titulo: propertyIds.name, valor: propertyIds.amount, prazo: "created_time" }, variant: "compact" },
    });
    const [audit] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, view.id), eq(schema.auditEvents.action, "bases.view.created")));
    expect((audit!.metadataJson as J).widgetItemId).toBe(items.pedido);

    // Sent back as returned (keys, itemId and ref), it saves unchanged; the update is audited too.
    const updated = expectOk(await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: view.version, layout: view.layout }));
    expect(updated.layout).toEqual(view.layout);
    expect(updated.version).toBe(view.version + 1);
    const [updateAudit] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, view.id), eq(schema.auditEvents.action, "bases.view.updated")));
    expect((updateAudit!.metadataJson as J).widgetItemId).toBe(items.pedido);
  });

  test("refs resolve by itemId, by bare slug (the project, then the organization), and by project slug", async () => {
    const list = async (widget: unknown) => createView({ name: `List ${randomUUID().slice(0, 6)}`, columns: COLUMNS, layout: { type: "list", widget } });
    expect(expectOk(await list({ itemId: items.pedido }), 201).layout.widget).toMatchObject({ itemId: items.pedido, ref: "org/pedido-card", fields: {} });
    expect(expectOk(await list({ ref: "pedido-card" }), 201).layout.widget.itemId).toBe(items.pedido);
    expect(expectOk(await list({ ref: "proj-card" }), 201).layout.widget).toMatchObject({ itemId: items.proj, ref: `${projectA.slug}/proj-card` });
    expect(expectOk(await list({ ref: `${projectA.slug}/proj-card` }), 201).layout.widget.itemId).toBe(items.proj);
    expect(expectOk(await list({ itemId: items.pedido, ref: "org/pedido-card", variant: "default" }), 201).layout.widget.itemId).toBe(items.pedido);
    expectFieldError(await list({ itemId: items.pedido, ref: "proj-card" }), "layout.widget.ref", /different Library items/);
    const gallery = expectOk(
      await createView({
        name: "Gallery",
        columns: [...COLUMNS, "cover"],
        layout: { type: "gallery", coverProp: "cover", widget: { ref: "pedido-card", fields: { capa: "cover", fase: "stage" } } },
      }),
      201,
    );
    expect(gallery.layout.widget.fields).toEqual({ capa: "cover", fase: "stage" });
    const calendar = expectOk(
      await createView({ name: "Calendar", columns: COLUMNS, layout: { type: "calendar", dateProp: "due", widget: { itemId: items.pedido, fields: { prazo: "due" } } } }),
      201,
    );
    expect(calendar.layout).toMatchObject({ type: "calendar", dateProp: "due", widget: { fields: { prazo: "due" } } });
  });

  test("items of another kind, organization, or project, archived, unpublished, or missing are rejected", async () => {
    expectFieldError(await createView(board({ itemId: items.skill })), "layout.widget.itemId", /is a skill, not a widget/);
    expectFieldError(await createView(board({ itemId: items.foreign })), "layout.widget.itemId", /No Library item/);
    expectFieldError(await createView(board({ itemId: randomUUID() })), "layout.widget.itemId", /No Library item/);
    expectFieldError(await createView(board({ itemId: items.otherProject })), "layout.widget.itemId", /another project/);
    expectFieldError(await createView(board({ ref: `${projectB.slug}/other-card` })), "layout.widget.ref", /not visible/);
    expectFieldError(await createView(board({ ref: "other-card" })), "layout.widget.ref", /No widget/);
    expectFieldError(await createView(board({ ref: "org/foreign-card" })), "layout.widget.ref", /No widget/);
    expectFieldError(await createView(board({ ref: "org/some-skill" })), "layout.widget.ref", /No widget/);
    expectFieldError(await createView(board({ ref: "org/archived-card" })), "layout.widget.ref", /archived/);
    expectFieldError(await createView(board({ itemId: items.archived })), "layout.widget.itemId", /archived/);
    expectFieldError(await createView(board({ ref: "org/draft-card" })), "layout.widget.ref", /no published version/);
    expectFieldError(await createView(board({ ref: "a/b/c" })), "layout.widget.ref");
  });

  test("mapped columns must be projected and accepted by the widget field; unmapped required fields are fine", async () => {
    expectFieldError(await createView(board({ ref: "org/pedido-card", fields: { capa: "cover" } })), "layout.widget.fields.capa", /not a view column/);
    expectFieldError(await createView(board({ ref: "org/pedido-card", fields: { valor: "name" } })), "layout.widget.fields.valor", /\(number\).*\(text\)/);
    expectFieldError(await createView(board({ ref: "org/pedido-card", fields: { fase: "amount" } })), "layout.widget.fields.fase", /cannot show/);
    expectFieldError(await createView(board({ ref: "org/pedido-card", fields: { prazo: "nope" } })), "layout.widget.fields.prazo", /Unknown column/);
    expectFieldError(await createView(board({ ref: "org/pedido-card", fields: { cliente: "name" } })), "layout.widget.fields.cliente", /no field "cliente"/);
    expectFieldError(await createView(board({ ref: "org/pedido-card", variant: "detail" })), "layout.widget.variant", /no "detail" variant/);
    const ok = expectOk(await createView(board({ ref: "org/pedido-card", fields: { titulo: "amount", fase: "stage" } })), 201);
    expect(ok.layout.widget.fields).toEqual({ titulo: "amount", fase: "stage" });
  });

  test("table layouts and unnamed widgets are payload_invalid; binding needs base.manage and the view version", async () => {
    const table = await createView({ name: "Table", layout: { type: "table", widget: { ref: "org/pedido-card" } } });
    expect([table.status, table.body.error]).toEqual([400, "payload_invalid"]);
    const unnamed = await createView(board({ fields: { titulo: "name" } }));
    expect([unnamed.status, unnamed.body.error]).toEqual([400, "payload_invalid"]);

    const view = expectOk(await createView(board(null)), 201);
    expect(view.layout).toEqual({ type: "board", groupBy: "stage" });
    const layout = { type: "board", groupBy: "stage", widget: { ref: "org/pedido-card" } };
    const denied = await call(viewer, "PATCH", `orders/views/${view.id}`, { expectedVersion: view.version, layout });
    expect([denied.status, denied.body.error]).toEqual([403, "base_forbidden"]);
    const stale = await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: view.version + 5, layout });
    expect([stale.status, stale.body.error]).toEqual([409, "version_conflict"]);
    const bound = expectOk(await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: view.version, layout }));
    expect(bound.layout.widget).toMatchObject({ itemId: items.pedido, ref: "org/pedido-card", variant: "default" });
  });

  test("archiving the bound widget later leaves the view valid; a rename keeps the binding; re-sending it is checked again", async () => {
    const view = expectOk(
      await createView(
        board(
          { ref: "org/temp-card", fields: { titulo: "name" } },
          { access: { read: [{ kind: "project_role", minRole: "viewer" }] } },
        ),
      ),
      201,
    );
    await db.update(schema.libraryItems).set({ archivedAt: new Date() }).where(eq(schema.libraryItems.id, items.temp));

    const got = expectOk(await call(owner, "GET", `orders/views/${view.id}`));
    expect(got.valid).toBe(true);
    expect(got.view.valid).toBe(true);
    expect(got.layout.widget).toEqual({ itemId: items.temp, ref: "org/temp-card", fields: { titulo: "name" }, variant: "default" });
    expectOk(await call(viewer, "POST", `orders/views/${view.id}/query`, {}));
    // The public shape carries the binding by key.
    const publicShape = expectOk(await call(viewer, "GET", `orders/views/${view.id}`));
    expect(publicShape.view).toBeUndefined();
    expect(publicShape.layout.widget).toEqual({ itemId: items.temp, ref: "org/temp-card", fields: { titulo: "name" }, variant: "default" });

    const renamed = expectOk(await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: view.version, name: "Renamed" }));
    expect(renamed.layout.widget.itemId).toBe(items.temp);
    expectFieldError(
      await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: renamed.version, layout: renamed.layout }),
      "layout.widget.itemId",
      /archived/,
    );
    const cleared = expectOk(
      await call(owner, "PATCH", `orders/views/${view.id}`, { expectedVersion: renamed.version, layout: { ...renamed.layout, widget: null } }),
    );
    expect(cleared.layout).toEqual({ type: "board", groupBy: "stage" });
  });

  test("property dependents list views whose widget maps the property", async () => {
    const view = expectOk(await createView(board({ ref: "org/pedido-card", fields: { valor: "amount" } })), 201);
    const dryRun = expectOk(await call(owner, "POST", "orders/properties/amount/delete", { expectedSchemaVersion: await schemaVersion() }));
    expect(dryRun.report.dryRun).toBe(true);
    expect(dryRun.report.dependents.views.map((entry: J) => entry.id)).toContain(view.id);

    // A stored mapping to a column outside the projection (not writable through the API) still counts.
    const [direct] = await db
      .insert(schema.baseViews)
      .values({
        baseId: view.baseId,
        organizationId: orgId,
        projectId: projectA.id,
        name: "Direct",
        columnsJson: [propertyIds.name!],
        queryJson: { filter: null, sort: [], refTypes: {} },
        layoutJson: { type: "list", widget: { itemId: items.pedido, fields: { titulo: propertyIds.name, valor: propertyIds.notes }, variant: "default" } },
        accessJson: {},
        position: 40,
        createdByActorType: "user",
        createdByActorId: owner.id,
        updatedByActorType: "user",
        updatedByActorId: owner.id,
      })
      .returning();
    const notes = expectOk(await call(owner, "POST", "orders/properties/notes/delete", { expectedSchemaVersion: await schemaVersion() }));
    expect(notes.report.dependents.views.map((entry: J) => entry.id)).toContain(direct!.id);
    const got = expectOk(await call(owner, "GET", `orders/views/${direct!.id}`));
    expect(got.valid).toBe(true);
    expect(got.layout.widget.fields).toEqual({ titulo: "name" });

    // Deleting the property for real does not touch the binding; the view stays valid.
    expectOk(await call(owner, "POST", "orders/properties/notes/delete", { expectedSchemaVersion: await schemaVersion(), confirm: true }));
    const after = expectOk(await call(owner, "GET", `orders/views/${direct!.id}`));
    expect(after.valid).toBe(true);
    expect(after.layout.widget).toEqual({ itemId: items.pedido, ref: "org/pedido-card", fields: { titulo: "name" }, variant: "default" });
  });
});
