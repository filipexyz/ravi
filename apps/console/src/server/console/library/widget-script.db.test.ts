import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Widgets with widget.js (JS-CONTRACT section 6): who publishes code (J4) and
// the audit endpoint. Runs only with LIBRARY_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a migrated Console database.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const project = { id: randomUUID(), slug: `ws-a-${suffix}` };

const makeUser = (label: string, orgRole: TestUser["orgRole"]): TestUser => ({
  id: randomUUID(),
  email: `library-ws-${suffix}-${label}@example.test`,
  orgRole,
});
const owner = makeUser("owner", "owner");
const admin = makeUser("admin", "admin");
const dev = makeUser("dev", "developer");
const projAdmin = makeUser("projadmin", "viewer"); // project_admin of the project
const USERS = [owner, admin, dev, projAdmin];

async function call(user: TestUser, method: string, path: string, options: { body?: unknown; surface?: "cli" | "console" } = {}): Promise<Res> {
  try {
    const result = await routeLibraryRequest({
      workspace: { user: { id: user.id }, organization: { id: orgId }, membership: { role: user.orgRole } },
      actor: { surface: options.surface ?? "cli", requestId: randomUUID(), localInstallationId: null, origin: "https://console.test" },
      method,
      segments: path.split("/").filter(Boolean),
      body: options.body ?? {},
      searchParams: new URLSearchParams(),
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.payload)) };
  } catch (error) {
    if (error instanceof CliApiError) return { status: error.status, body: { code: error.code, message: error.message, details: error.details } };
    throw error;
  }
}

function expectStatus(res: Res, status: number, code?: string, reason?: string) {
  if (res.status !== status || (code && res.body?.code !== code) || (reason && res.body?.details?.reason !== reason)) {
    throw new Error(`expected ${status} ${code ?? ""} ${reason ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

const MANIFEST = JSON.stringify({
  name: "Vendas",
  description: "Vendas do mês com gráfico.",
  fields: { titulo: { type: "text", required: true }, total: { type: "number" } },
});
const HTML = '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-canvas label="Vendas por dia"></ravi-canvas></ravi-card>';
const PLAIN_HTML = "<ravi-card><ravi-title>{titulo}</ravi-title></ravi-card>";
const SCRIPT = "export function mount(card, ctx) { ctx.canvas(0).textContent = 'ok'; return {}; }\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const files = (script: string | null = SCRIPT) => [
  { path: "widget.json", content: MANIFEST },
  { path: "widget.html", content: script === null ? PLAIN_HTML : HTML },
  ...(script === null ? [] : [{ path: "widget.js", content: script }]),
];
const body = (slug: string, scope: "org" | "project" = "project", script: string | null = SCRIPT) => ({
  scope,
  ...(scope === "project" ? { project: project.slug } : {}),
  slug,
  files: files(script),
});

describeDb("library widgets with widget.js (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-ws-${suffix}`, name: "Library widget code test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([{ id: project.id, organizationId: orgId, slug: project.slug, name: "Project A" }]);
    await db.insert(schema.projectMemberships).values([{ projectId: project.id, userId: projAdmin.id, role: "project_admin" }]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("J4: only org owners and admins publish a widget with widget.js, in project scope too", async () => {
    expectStatus(await call(projAdmin, "POST", "widgets", { body: body("vendas-proj") }), 403, "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN");
    // The same project admin still publishes a widget without code.
    expectStatus(await call(projAdmin, "POST", "widgets", { body: body("vendas-plain", "project", null) }), 201);
    const published = expectStatus(await call(admin, "POST", "widgets", { body: body("vendas-proj") }), 201);
    expect(published.item).toMatchObject({ ref: `${project.slug}/vendas-proj`, version: 1 });
    expectStatus(await call(owner, "POST", "widgets", { body: body("vendas-org", "org") }), 201);
  });

  test("J4: developers propose code; publishing the proposal and reverting to code need an org admin", async () => {
    const proposal = expectStatus(await call(dev, "POST", "widgets/proposals", { body: { ...body("vendas-prop"), submit: true } }), 201);
    const number = proposal.proposal.number;
    const path = `widgets/${project.slug}/vendas-prop/proposals/${number}/publish`;
    expectStatus(await call(projAdmin, "POST", path), 403, "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN");
    expectStatus(await call(owner, "POST", path), 200);

    // v2 without code by the project admin, then reverting to v1 (with code) is refused to them.
    expectStatus(await call(projAdmin, "POST", "widgets", { body: body("vendas-prop", "project", null) }), 201);
    expectStatus(await call(projAdmin, "POST", `widgets/${project.slug}/vendas-prop/versions/1/revert`), 403, "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN");
    expectStatus(await call(admin, "POST", `widgets/${project.slug}/vendas-prop/versions/1/revert`), 201);
  });

  test("show answers the script, its audit and whether it passes; a new version starts unaudited", async () => {
    const shown = expectStatus(await call(dev, "GET", "widgets/org/vendas-org"), 200);
    expect(shown.version).toMatchObject({ script: { sha256: sha(SCRIPT), bytes: SCRIPT.length }, scriptAudit: null, scriptAudited: false, canAudit: false });
    expect(expectStatus(await call(owner, "GET", "widgets/org/vendas-org"), 200).version.canAudit).toBe(true);
    const plain = expectStatus(await call(dev, "GET", `widgets/${project.slug}/vendas-plain`), 200);
    expect(plain.version).toMatchObject({ script: null, scriptAudited: true, canAudit: false });
  });

  test("the audit endpoint: Console only, org owner or admin, this version's script, status from the violations", async () => {
    const path = "widgets/org/vendas-org/versions/1/audit";
    const pass = { status: "pass", violations: [{ id: "region", impact: "moderate", help: "Content in landmarks", nodes: 1 }], scriptSha256: sha(SCRIPT) };
    expectStatus(await call(owner, "POST", path, { body: pass }), 404, "NOT_FOUND");
    expectStatus(await call(dev, "POST", path, { body: pass, surface: "console" }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", path, { body: { ...pass, scriptSha256: sha("other") }, surface: "console" }), 409, "CONFLICT", "script_mismatch");
    expectStatus(
      await call(owner, "POST", path, { body: { ...pass, violations: [{ id: "color-contrast", impact: "serious", help: "Contrast", nodes: 2 }] }, surface: "console" }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(await call(owner, "POST", "widgets/org/vendas-org/versions/9/audit", { body: pass, surface: "console" }), 404, "NOT_FOUND");
    expectStatus(
      await call(owner, "POST", `widgets/${project.slug}/vendas-plain/versions/1/audit`, { body: pass, surface: "console" }),
      409,
      "CONFLICT",
      "no_script",
    );

    const fail = { status: "fail", violations: [{ id: "color-contrast", impact: "serious", help: "Contrast", nodes: 2 }], scriptSha256: sha(SCRIPT) };
    expect(expectStatus(await call(admin, "POST", path, { body: fail, surface: "console" }), 200).audit).toMatchObject({ status: "fail" });
    expect(expectStatus(await call(dev, "GET", "widgets/org/vendas-org"), 200).version).toMatchObject({ scriptAudit: { status: "fail" }, scriptAudited: false });

    const stored = expectStatus(await call(owner, "POST", path, { body: pass, surface: "console" }), 200);
    expect(stored).toMatchObject({ ref: "org/vendas-org", version: 1, audit: { status: "pass", scriptSha256: sha(SCRIPT), auditedBy: owner.id } });
    expect(expectStatus(await call(dev, "GET", "widgets/org/vendas-org"), 200).version).toMatchObject({ scriptAudit: { status: "pass" }, scriptAudited: true });

    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "library.widget.script_audited")));
    expect(events).toHaveLength(2);
  });
});
