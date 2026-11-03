import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";
import { resolveEffectiveTheme } from "./themes";

// Themes, widgets and theme pointers through `routeLibraryRequest`, one test
// per CHECKS.md line. Runs only with LIBRARY_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a migrated Console database.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };
type File = { path: string; content: string };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `wt-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `wt-b-${suffix}` };
const siteA = { id: randomUUID(), slug: `wt-site-a-${suffix}`, hostname: `wt-a-${suffix}.ravi.page` };
const siteB = { id: randomUUID(), slug: `wt-site-b-${suffix}`, hostname: `wt-b-${suffix}.ravi.page` };
const siteOff = { id: randomUUID(), slug: `wt-site-off-${suffix}`, hostname: `wt-off-${suffix}.ravi.page` };

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-wt-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const projAdmin = makeUser("projadmin", "viewer"); // project_admin of A
const viewerA = makeUser("viewera", "viewer"); // project viewer of A
const USERS = [owner, dev, projAdmin, viewerA];

async function call(user: TestUser, method: string, path: string, options: { body?: unknown; query?: string } = {}): Promise<Res> {
  try {
    const result = await routeLibraryRequest({
      workspace: { user: { id: user.id }, organization: { id: orgId }, membership: { role: user.orgRole } },
      actor: { surface: "cli", requestId: randomUUID(), localInstallationId: null, origin: "https://console.test" },
      method,
      segments: path.split("/").filter(Boolean),
      body: options.body ?? {},
      searchParams: new URLSearchParams(options.query ?? ""),
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.payload)) };
  } catch (error) {
    if (error instanceof CliApiError) {
      return { status: error.status, body: { code: error.code, message: error.message, details: error.details } };
    }
    throw error;
  }
}

function expectStatus(res: Res, status: number, code?: string, reason?: string) {
  if (res.status !== status || (code && res.body?.code !== code) || (reason && res.body?.details?.reason !== reason)) {
    throw new Error(`expected ${status} ${code ?? ""} ${reason ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function themeFiles(input: { name?: string; description?: string | null; textPrimary?: string; extra?: File[] } = {}): File[] {
  const theme: Record<string, unknown> = {
    ...(input.description === null ? {} : { $description: input.description ?? "Cores e tipografia da clínica." }),
    $extensions: { ravi: { name: input.name ?? "Clínica Azul", locale: "pt-BR" } },
    color: {
      light: {
        background: { primary: { $type: "color", $value: "#ffffff" } },
        text: { primary: { $type: "color", $value: input.textPrimary ?? "#1a1a1a" } },
      },
    },
  };
  return [{ path: "theme.json", content: JSON.stringify(theme, null, 2) }, ...(input.extra ?? [])];
}

const WIDGET_MANIFEST = {
  name: "Cartão de pedido",
  description: "Pedido com status, prazo, responsável e valor.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    status: { type: "status" },
    prazo: { type: "date" },
    responsavel: { type: "person", label: "Responsável" },
    valor: { type: "number", role: "highlight", label: "Valor" },
  },
  variants: ["default"],
};

const WIDGET_HTML = [
  "<ravi-card>",
  "  <ravi-title>{titulo}</ravi-title>",
  '  <ravi-row justify="between">',
  '    <ravi-field name="status"></ravi-field>',
  '    <ravi-field name="prazo"></ravi-field>',
  "  </ravi-row>",
  '  <ravi-field name="responsavel" label="visible"></ravi-field>',
  '  <ravi-metric value="{valor}" label="Valor"></ravi-metric>',
  "</ravi-card>",
].join("\n");

function widgetFiles(input: { html?: string; manifest?: unknown; omitManifest?: boolean; extra?: File[] } = {}): File[] {
  return [
    { path: "widget.html", content: input.html ?? WIDGET_HTML },
    ...(input.omitManifest ? [] : [{ path: "widget.json", content: JSON.stringify(input.manifest ?? WIDGET_MANIFEST, null, 2) }]),
    ...(input.extra ?? []),
  ];
}

function itemBody(slug: string, files: File[], input: { scope?: "org" | "project"; project?: string; description?: string; submit?: boolean } = {}) {
  return {
    scope: input.scope ?? "org",
    ...(input.project ? { project: input.project } : {}),
    slug,
    ...(input.description ? { description: input.description } : {}),
    files,
    ...(input.submit !== undefined ? { submit: input.submit } : {}),
  };
}

const pointerAudits = async () =>
  db
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, "library.theme.pointer.set")));

const itemCount = async (slug: string) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.libraryItems)
    .where(and(eq(schema.libraryItems.organizationId, orgId), eq(schema.libraryItems.slug, slug)));
  return Number(row?.count ?? 0);
};

const hasError = (diagnostics: J[], file: string) => diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.file === file);

describeDb("library themes and widgets (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-wt-${suffix}`, name: "Library themes test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([
      { projectId: projectA.id, userId: projAdmin.id, role: "project_admin" },
      { projectId: projectA.id, userId: viewerA.id, role: "viewer" },
    ]);
    await db.insert(schema.pageSites).values([
      { id: siteA.id, organizationId: orgId, projectId: projectA.id, slug: siteA.slug, defaultHostname: siteA.hostname },
      { id: siteB.id, organizationId: orgId, projectId: projectB.id, slug: siteB.slug, defaultHostname: siteB.hostname },
      { id: siteOff.id, organizationId: orgId, projectId: projectA.id, slug: siteOff.slug, defaultHostname: siteOff.hostname, status: "disabled" },
    ]);
    const route = (site: { id: string }, projectId: string, path: string, status: "active" | "disabled" = "active") => ({
      organizationId: orgId,
      projectId,
      siteId: site.id,
      path,
      matchType: "exact" as const,
      status,
    });
    await db.insert(schema.pageRoutes).values([
      route(siteA, projectA.id, "/"),
      route(siteA, projectA.id, "/pedidos"),
      route(siteA, projectA.id, "/old", "disabled"),
      route(siteB, projectB.id, "/"),
      route(siteOff, projectA.id, "/"),
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("themes and widgets publish under themes/ and widgets/, taking name and description from their files", async () => {
    const theme = expectStatus(await call(owner, "POST", "themes", { body: itemBody("clinica-azul", themeFiles()) }), 201);
    expect(theme.item).toMatchObject({ ref: "org/clinica-azul", kind: "theme", name: "Clínica Azul", description: "Cores e tipografia da clínica.", version: 1 });
    expect(Array.isArray(theme.diagnostics)).toBe(true);

    const widget = expectStatus(await call(owner, "POST", "widgets", { body: itemBody("pedido-card", widgetFiles()) }), 201);
    expect(widget.item).toMatchObject({ ref: "org/pedido-card", kind: "widget", name: "Cartão de pedido", version: 1 });
    expect(widget.item.description).toBe(WIDGET_MANIFEST.description);

    const named = expectStatus(
      await call(owner, "POST", "widgets", { body: { ...itemBody("pedido-mini", widgetFiles()), name: "Mini", description: "Do corpo" } }),
      201,
    );
    expect(named.item).toMatchObject({ name: "Mini", description: "Do corpo" });

    const shown = expectStatus(await call(dev, "GET", "widgets/org/pedido-card"), 200);
    expect(shown.version.files.map((file: J) => file.path)).toEqual(["widget.html", "widget.json"]);
    expectStatus(await call(dev, "GET", "skills/org/pedido-card"), 404, "NOT_FOUND");
    expectStatus(await call(owner, "GET", "themes/org/clinica-azul/pins"), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "widgets/org/pedido-card/pin", { body: { agentId: "main" } }), 404, "NOT_FOUND");
  });

  test("each kind holds only its files", async () => {
    expectStatus(
      await call(owner, "POST", "themes", { body: itemBody("bad-theme", themeFiles({ extra: [{ path: "script.js", content: "x" }] })) }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(await call(owner, "POST", "widgets", { body: itemBody("bad-widget", widgetFiles({ omitManifest: true })) }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "widgets", { body: itemBody("bad-widget", themeFiles()) }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "themes", { body: itemBody("bad-theme", themeFiles({ description: null })) }), 400, "PAYLOAD_INVALID");
    expect(await itemCount("bad-theme")).toBe(0);
    expect(await itemCount("bad-widget")).toBe(0);
  });

  test("a theme failing contrast and a widget with a template error are rejected with diagnostics", async () => {
    const pale = expectStatus(
      await call(owner, "POST", "themes", { body: itemBody("palida", themeFiles({ textPrimary: "#f4f4f4" })) }),
      400,
      "PAYLOAD_INVALID",
    );
    expect(hasError(pale.details.diagnostics, "theme.json")).toBe(true);
    expect(pale.details.diagnostics.map((diagnostic: J) => diagnostic.code)).toContain("THEME_CONTRAST");

    const broken = expectStatus(
      await call(owner, "POST", "widgets", {
        body: itemBody("quebrado", widgetFiles({ html: WIDGET_HTML.replace('name="prazo"', 'name="vencimento"') })),
      }),
      400,
      "PAYLOAD_INVALID",
    );
    expect(hasError(broken.details.diagnostics, "widget.html")).toBe(true);
    const error = broken.details.diagnostics.find((diagnostic: J) => diagnostic.severity === "error");
    expect(typeof error.line).toBe("number");
    expect(await itemCount("palida")).toBe(0);
    expect(await itemCount("quebrado")).toBe(0);
  });

  test("theme and widget proposals compile on create, update, publish and revert", async () => {
    const created = expectStatus(
      await call(dev, "POST", "themes/proposals", { body: itemBody("clinica-azul", themeFiles({ name: "Clínica Azul 2" }), { submit: true }) }),
      201,
    );
    expect(created.proposal).toMatchObject({ ref: "org/clinica-azul", status: "proposed", baseVersion: 1, name: "Clínica Azul 2" });
    expect(created.proposal.reviewPath).toBe(`/${orgId}/library/org/clinica-azul/proposals/${created.proposal.number}?kind=theme`);
    expect(Array.isArray(created.diagnostics)).toBe(true);
    const [inbox] = await db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.eventType, "library.theme.proposed")));
    expect(inbox?.title).toBe("A theme change is waiting for review");

    const number = created.proposal.number;
    const pale = expectStatus(
      await call(dev, "POST", `themes/org/clinica-azul/proposals/${number}/update`, { body: { files: themeFiles({ textPrimary: "#fafafa" }) } }),
      400,
      "PAYLOAD_INVALID",
    );
    expect(hasError(pale.details.diagnostics, "theme.json")).toBe(true);
    expectStatus(
      await call(dev, "POST", `themes/org/clinica-azul/proposals/${number}/update`, { body: { files: themeFiles({ name: "Clínica Azul 3" }) } }),
      200,
    );
    expectStatus(await call(dev, "POST", `themes/org/clinica-azul/proposals/${number}/publish`), 403, "ORG_ACCESS_DENIED");
    const published = expectStatus(await call(owner, "POST", `themes/org/clinica-azul/proposals/${number}/publish`), 200);
    expect(published.item).toMatchObject({ kind: "theme", version: 2, name: "Clínica Azul 3" });

    const reverted = expectStatus(await call(owner, "POST", "themes/org/clinica-azul/versions/1/revert"), 201);
    expect(reverted.version.number).toBe(3);

    expectStatus(
      await call(dev, "POST", "widgets/proposals", {
        body: itemBody("pedido-novo", widgetFiles({ html: WIDGET_HTML.replace("{titulo}", "{nada}") })),
      }),
      400,
      "PAYLOAD_INVALID",
    );
    expect(await itemCount("pedido-novo")).toBe(0);
    const draft = expectStatus(await call(dev, "POST", "widgets/proposals", { body: itemBody("pedido-novo", widgetFiles()) }), 201);
    expect(draft.proposal).toMatchObject({ ref: "org/pedido-novo", status: "draft", name: "Cartão de pedido" });
    expectStatus(await call(dev, "POST", `widgets/org/pedido-novo/proposals/${draft.proposal.number}/submit`), 200);
    const widget = expectStatus(await call(owner, "POST", `widgets/org/pedido-novo/proposals/${draft.proposal.number}/publish`), 200);
    expect(widget.item).toMatchObject({ kind: "widget", version: 1 });
  });

  test("widget search finds a widget by its fields' keys and labels", async () => {
    const byLabel = expectStatus(await call(dev, "GET", "widgets", { query: "q=responsavel" }), 200);
    expect(byLabel.items.map((item: J) => item.ref)).toContain("org/pedido-card");
    const byKeys = expectStatus(await call(dev, "GET", "widgets", { query: "q=prazo valor" }), 200);
    expect(byKeys.items.map((item: J) => item.ref)).toContain("org/pedido-card");
    expect(byKeys.items.every((item: J) => item.kind === "widget")).toBe(true);
    const skills = expectStatus(await call(dev, "GET", "skills", { query: "q=prazo" }), 200);
    expect(skills.items).toEqual([]);
  });

  test("route words are reserved per kind, and only for that kind", async () => {
    for (const slug of ["active", "default", "none", "check", "proposals"]) {
      expectStatus(await call(owner, "POST", "themes", { body: itemBody(slug, themeFiles()) }), 409, "CONFLICT", "slug_reserved");
    }
    for (const slug of ["catalog", "check", "preview", "scaffold", "proposals", "none"]) {
      expectStatus(await call(owner, "POST", "widgets", { body: itemBody(slug, widgetFiles()) }), 409, "CONFLICT", "slug_reserved");
    }
    expectStatus(await call(dev, "POST", "themes/proposals", { body: itemBody("active", themeFiles()) }), 409, "CONFLICT", "slug_reserved");
    // A widget may be named `active`, and Ravi's skill names are free for themes.
    expectStatus(await call(owner, "POST", "widgets", { body: itemBody("active", widgetFiles()) }), 201);
    expectStatus(await call(owner, "POST", "themes", { body: itemBody("pages", themeFiles()) }), 201);
  });

  test("only org owners and admins point the org at a theme; a dry run only plans", async () => {
    const empty = expectStatus(await call(dev, "GET", "themes/active"), 200);
    expect(empty).toMatchObject({ org: null, project: null, effective: null, warnings: [] });

    expectStatus(await call(dev, "POST", "themes/active", { body: { scope: "org", ref: "org/clinica-azul" } }), 403, "ORG_ACCESS_DENIED");
    expectStatus(
      await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/clinica-azul", agent: { id: "main" } } }),
      403,
      "ORG_ACCESS_DENIED",
    );
    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", project: projectA.slug, ref: "org/clinica-azul" } }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/nao-existe" } }), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/pedido-card" } }), 404, "NOT_FOUND");

    const planned = expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/clinica-azul", dryRun: true } }), 200);
    expect(planned.applied).toBe(false);
    expect(planned.plan).toMatchObject({ scope: "org", project: null, from: null, to: { ref: "org/clinica-azul", scope: "org", slug: "clinica-azul" } });
    expect(planned.plan.affectedHosts).toEqual([
      { siteSlug: siteA.slug, hostname: siteA.hostname, routes: 2 },
      { siteSlug: siteB.slug, hostname: siteB.hostname, routes: 1 },
    ]);
    expect(expectStatus(await call(dev, "GET", "themes/active"), 200).org).toBeNull();
    expect(await pointerAudits()).toHaveLength(0);

    const applied = expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "clinica-azul" } }), 200);
    expect(applied).toMatchObject({ applied: true, unchanged: false, plan: { to: { ref: "org/clinica-azul", setBy: { name: expect.any(String) } } } });
    const audits = await pointerAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.afterJson).toEqual({ itemId: applied.plan.to.itemId });
    expect(audits[0]?.targetType).toBe("library_theme_pointer");

    const again = expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/clinica-azul" } }), 200);
    expect(again).toMatchObject({ applied: true, unchanged: true });
    expect(await pointerAudits()).toHaveLength(1);

    const active = expectStatus(await call(viewerA, "GET", "themes/active"), 200);
    expect(active.org).toMatchObject({ ref: "org/clinica-azul", scope: "org" });
    expect(active.effective).toMatchObject({ ref: "org/clinica-azul", source: "org", version: 3 });
    expect(active.effective.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(active.can).toEqual({ setOrg: false, setProject: false });
  });

  test("an org pointer names an org theme; a project pointer an org theme or its own, and wins over the org's", async () => {
    expectStatus(
      await call(projAdmin, "POST", "themes", { body: itemBody("clinica-a", themeFiles({ name: "Clínica A" }), { scope: "project", project: projectA.slug }) }),
      201,
    );
    expectStatus(
      await call(owner, "POST", "themes/active", { body: { scope: "org", ref: `${projectA.slug}/clinica-a` } }),
      409,
      "CONFLICT",
      "theme_out_of_scope",
    );
    expectStatus(
      await call(owner, "POST", "themes/active", { body: { scope: "project", project: projectB.slug, ref: `${projectA.slug}/clinica-a` } }),
      409,
      "CONFLICT",
      "theme_out_of_scope",
    );
    expectStatus(
      await call(projAdmin, "POST", "themes/active", { body: { scope: "project", project: projectB.slug, ref: "org/clinica-azul" } }),
      403,
      "PROJECT_ACCESS_DENIED",
    );
    expectStatus(
      await call(viewerA, "POST", "themes/active", { body: { scope: "project", project: projectA.slug, ref: "clinica-a" } }),
      403,
      "PROJECT_ACCESS_DENIED",
    );
    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "project", ref: "clinica-a" } }), 400, "PAYLOAD_INVALID");

    const planned = expectStatus(
      await call(projAdmin, "POST", "themes/active", { body: { scope: "project", project: projectA.slug, ref: "clinica-a", dryRun: true } }),
      200,
    );
    expect(planned.plan).toMatchObject({ scope: "project", project: { slug: projectA.slug }, from: null, to: { ref: `${projectA.slug}/clinica-a` } });
    expect(planned.plan.affectedHosts).toEqual([{ siteSlug: siteA.slug, hostname: siteA.hostname, routes: 2 }]);
    expectStatus(await call(projAdmin, "POST", "themes/active", { body: { scope: "project", project: projectA.slug, ref: "clinica-a" } }), 200);

    const inA = expectStatus(await call(viewerA, "GET", "themes/active", { query: `project=${projectA.slug}` }), 200);
    expect(inA.org.ref).toBe("org/clinica-azul");
    expect(inA.project.ref).toBe(`${projectA.slug}/clinica-a`);
    expect(inA.effective).toMatchObject({ ref: `${projectA.slug}/clinica-a`, source: "project", version: 1 });
    const inB = expectStatus(await call(owner, "GET", "themes/active", { query: `project=${projectB.slug}` }), 200);
    expect(inB).toMatchObject({ project: null, effective: { ref: "org/clinica-azul", source: "org" } });
    expectStatus(await call(viewerA, "GET", "themes/active", { query: `project=${projectB.slug}` }), 404, "NOT_FOUND");

    // The org pointer no longer reaches project A's site, which has its own theme.
    const orgPlan = expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/pages", dryRun: true } }), 200);
    expect(orgPlan.plan.from.ref).toBe("org/clinica-azul");
    expect(orgPlan.plan.affectedHosts.map((host: J) => host.siteSlug)).toEqual([siteB.slug]);

    const forA = await resolveEffectiveTheme({ organizationId: orgId, projectId: projectA.id });
    expect(forA).toMatchObject({ source: "project", ref: `${projectA.slug}/clinica-a`, versionNumber: 1 });
    expect(forA?.files.map((file) => file.path)).toEqual(["theme.json"]);
    expect(await resolveEffectiveTheme({ organizationId: orgId, projectId: projectB.id })).toMatchObject({ source: "org", ref: "org/clinica-azul", versionNumber: 3 });
    expect(await resolveEffectiveTheme({ organizationId: orgId, projectId: null })).toMatchObject({ source: "org" });
  });

  test("an archived theme is skipped as if its pointer were absent", async () => {
    expectStatus(await call(projAdmin, "POST", `themes/${projectA.slug}/clinica-a/archive`), 200);
    const inA = expectStatus(await call(viewerA, "GET", "themes/active", { query: `project=${projectA.slug}` }), 200);
    expect(inA.project).toBeNull();
    expect(inA.effective).toMatchObject({ ref: "org/clinica-azul", source: "org" });
    expect(inA.warnings).toHaveLength(1);
    expect(inA.warnings[0]).toContain(`${projectA.slug}/clinica-a`);
    expect(await resolveEffectiveTheme({ organizationId: orgId, projectId: projectA.id })).toMatchObject({ source: "org" });
    expectStatus(
      await call(projAdmin, "POST", "themes/active", { body: { scope: "project", project: projectA.slug, ref: "clinica-a" } }),
      409,
      "CONFLICT",
      "not_published",
    );

    const cleared = expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: null } }), 200);
    expect(cleared).toMatchObject({ applied: true, plan: { from: { ref: "org/clinica-azul" }, to: null } });
    expect(expectStatus(await call(dev, "GET", "themes/active", { query: `project=${projectB.slug}` }), 200).effective).toBeNull();
    expect(await resolveEffectiveTheme({ organizationId: orgId, projectId: projectB.id })).toBeNull();
    expect(await pointerAudits()).toHaveLength(3);
  });

  test("skills and agents are unaffected", async () => {
    expectStatus(
      await call(owner, "POST", "skills", { body: { scope: "org", slug: "sem-descricao", files: [{ path: "SKILL.md", content: "x" }] } }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(
      await call(owner, "POST", "agents", { body: { scope: "org", slug: "sem-descricao", files: [{ path: "AGENTS.md", content: "x" }] } }),
      400,
      "PAYLOAD_INVALID",
    );
    // `active` is a theme route word only; skills and agents keep their own routes.
    expectStatus(
      await call(owner, "POST", "skills", { body: { scope: "org", slug: "active", description: "A skill", files: [{ path: "SKILL.md", content: "x" }] } }),
      201,
    );
    expect(expectStatus(await call(dev, "GET", "skills/active"), 200).item.kind).toBe("skill");
    expectStatus(await call(dev, "GET", "agents/active"), 404, "NOT_FOUND");
    const proposal = expectStatus(
      await call(dev, "POST", "skills/proposals", {
        body: { scope: "org", slug: "active", description: "A skill", files: [{ path: "SKILL.md", content: "y" }] },
      }),
      201,
    );
    expect(proposal.proposal.reviewPath).toBe(`/${orgId}/library/org/active/proposals/${proposal.proposal.number}`);
    expect(proposal.diagnostics).toBeUndefined();
    const themes = expectStatus(await call(dev, "GET", "themes"), 200);
    expect(themes.items.every((item: J) => item.kind === "theme")).toBe(true);
  });

  // The body `ravi widgets propose <dir> --scope org --execute` sends from an agent.
  const agentProposal = (slug: string, extra: Record<string, unknown> = {}) => ({
    scope: "org",
    slug,
    name: "Vitrine",
    description: "Vitrine de produtos.",
    externalAllowed: false,
    files: widgetFiles(),
    agent: { id: "main" },
    baseVersion: 0,
    submit: true,
    ...extra,
  });

  test("an agent proposes a new org widget; an admin publishes it", async () => {
    const created = expectStatus(await call(dev, "POST", "widgets/proposals", { body: agentProposal("vitrine") }), 201);
    expect(created.proposal).toMatchObject({ ref: "org/vitrine", status: "proposed", baseVersion: 0 });
    expect(created.proposal.author).toMatchObject({ agentId: "main" });
    const published = expectStatus(await call(owner, "POST", `widgets/org/vitrine/proposals/${created.proposal.number}/publish`), 200);
    expect(published.item).toMatchObject({ ref: "org/vitrine", version: 1 });
  });

  test("a slug a project holds is a CONFLICT that names the project and carries `conflict`", async () => {
    expectStatus(
      await call(owner, "POST", "widgets", { body: itemBody("vitrine-painel", widgetFiles(), { scope: "project", project: projectA.slug }) }),
      201,
    );
    const taken = expectStatus(await call(dev, "POST", "widgets/proposals", { body: agentProposal("vitrine-painel") }), 409, "CONFLICT", "slug_taken_in_project");
    expect(taken.details).toMatchObject({
      reason: "slug_taken_in_project",
      conflict: "slug_taken_in_project",
      ref: `${projectA.slug}/vitrine-painel`,
      project: projectA.slug,
      archived: false,
    });
    expect(taken.message).toContain(`Project "${projectA.slug}" already has a widget named "vitrine-painel"`);
    expect(taken.message).toContain(`--scope ${projectA.slug}`);
    // Publishing says the same.
    const publish = expectStatus(await call(owner, "POST", "widgets", { body: itemBody("vitrine-painel", widgetFiles()) }), 409, "CONFLICT", "slug_taken_in_project");
    expect(publish.details.ref).toBe(`${projectA.slug}/vitrine-painel`);
    // The org's slug, from a project.
    const orgTaken = expectStatus(
      await call(projAdmin, "POST", "widgets/proposals", { body: { ...agentProposal("vitrine"), scope: "project", project: projectA.slug } }),
      409,
      "CONFLICT",
      "slug_taken_in_org",
    );
    expect(orgTaken.details).toMatchObject({ conflict: "slug_taken_in_org", ref: "org/vitrine", scope: "org" });
  });

  test("an archived org widget, which show no longer returns, takes a proposal or publish written against version 0", async () => {
    expectStatus(await call(owner, "POST", "widgets", { body: itemBody("vitrine-velha", widgetFiles()) }), 201);
    expectStatus(await call(owner, "POST", "widgets/org/vitrine-velha/archive"), 200);
    expectStatus(await call(dev, "GET", "widgets/org/vitrine-velha"), 404, "NOT_FOUND");

    // Same files as the archived version: still a change, since publishing restores it.
    const created = expectStatus(await call(dev, "POST", "widgets/proposals", { body: agentProposal("vitrine-velha", { name: "Cartão de pedido", description: WIDGET_MANIFEST.description }) }), 201);
    expect(created.proposal).toMatchObject({ ref: "org/vitrine-velha", baseVersion: 1, stale: false });
    const published = expectStatus(await call(owner, "POST", `widgets/org/vitrine-velha/proposals/${created.proposal.number}/publish`), 200);
    expect(published.item).toMatchObject({ version: 2 });
    expectStatus(await call(dev, "GET", "widgets/org/vitrine-velha"), 200);

    expectStatus(await call(owner, "POST", "widgets/org/vitrine-velha/archive"), 200);
    const restored = expectStatus(await call(owner, "POST", "widgets", { body: { ...itemBody("vitrine-velha", widgetFiles()), baseVersion: 0 } }), 201);
    expect(restored.version.number).toBe(3);
    // A live item still checks its base.
    expectStatus(
      await call(owner, "POST", "widgets", { body: { ...itemBody("vitrine-velha", widgetFiles({ html: WIDGET_HTML.replace("Valor", "Total") })), baseVersion: 0 } }),
      409,
      "CONFLICT",
      "stale_base",
    );
  });
});
