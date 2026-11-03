import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { basesCallerFromCliAuth, basesCallerFromConsoleWorkspace, handleBasesRequest } from "@/server/console/bases";
import { routeLibraryRequest } from "@/server/console/library/cli";
import { db, schema } from "@/server/db";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import type { PageKit } from "@/shared/widgets/types";

import { cliPublishContextFromAuth, createPageUploadSession, finalizePageUploadSession } from "../publish";
import { listOutdatedPages } from "./outdated";
import { runPageKitForCli, type PageKitCliContext } from "./service";

// The page kit, `publish.presentation` and `pages/outdated` against a real
// database: Library themes and widgets published through the Library router,
// a base and views through the Bases router, publish with metadata-only
// storage. Runs only with LIBRARY_TEST_DATABASE_URL, BASES_TEST_DATABASE_URL
// and DATABASE_URL pointing at a migrated Console database.
const describeDb = process.env.LIBRARY_TEST_DATABASE_URL && process.env.BASES_TEST_DATABASE_URL ? describe : describe.skip;

type J = any;
type TestUser = { id: string; email: string; orgRole: "owner" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const project = { id: randomUUID(), slug: `kit-${suffix}` };
const otherProject = { id: randomUUID(), slug: `kit-other-${suffix}` };
const site = { id: randomUUID(), slug: `kit-${suffix}`, hostname: `kit-${suffix}.ravi.page` };
const otherSite = { id: randomUUID(), slug: `kit-other-${suffix}`, hostname: `kit-other-${suffix}.ravi.page` };
const CLI_SCOPES = ["console.projects.read", "console.projects.link", "artifacts.publish", "artifacts.read"];

const owner: TestUser = { id: randomUUID(), email: `kit-${suffix}-owner@example.test`, orgRole: "owner" };
const viewer: TestUser = { id: randomUUID(), email: `kit-${suffix}-viewer@example.test`, orgRole: "viewer" };
const USERS = [owner, viewer];

const WIDGET_MANIFEST = {
  name: "Cartão de pedido",
  description: "Pedido com status e valor.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    status: { type: "status" },
    valor: { type: "number", role: "highlight", label: "Valor" },
  },
  variants: ["default", "compact"],
};
const widgetHtml = (button: string) =>
  [
    "<ravi-card>",
    "  <ravi-title>{titulo}</ravi-title>",
    '  <ravi-field name="status"></ravi-field>',
    '  <ravi-metric value="{valor}" label="Valor"></ravi-metric>',
    `  ${button}`,
    "</ravi-card>",
  ].join("\n");

function themeFiles(name: string, textPrimary: string) {
  const theme = {
    $description: `Tema ${name}.`,
    $extensions: { ravi: { name, locale: "pt-BR" } },
    color: { light: { background: { primary: { $type: "color", $value: "#ffffff" } }, text: { primary: { $type: "color", $value: textPrimary } } } },
  };
  return [{ path: "theme.json", content: JSON.stringify(theme, null, 2) }];
}

function widgetFiles(button = '<ravi-button action="update" set="status=@done">Concluir</ravi-button>') {
  return [
    { path: "widget.html", content: widgetHtml(button) },
    { path: "widget.json", content: JSON.stringify(WIDGET_MANIFEST, null, 2) },
  ];
}

async function library(user: TestUser, method: string, path: string, body: unknown = {}) {
  const result = await routeLibraryRequest({
    workspace: { user: { id: user.id }, organization: { id: orgId }, membership: { role: user.orgRole } },
    actor: { surface: "cli", requestId: randomUUID(), localInstallationId: null, origin: "https://console.test" },
    method,
    segments: path.split("/").filter(Boolean),
    body,
    searchParams: new URLSearchParams(),
  });
  if (result.status >= 300) throw new Error(`library ${method} ${path}: ${result.status} ${JSON.stringify(result.payload)}`);
  return JSON.parse(JSON.stringify(result.payload)) as J;
}

async function bases(method: string, path: string, body: unknown = {}) {
  try {
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
      projectRef: project.slug,
      segments: path.split("/").filter(Boolean),
      body,
      searchParams: new URLSearchParams(),
      idempotencyKey: null,
    });
    return JSON.parse(JSON.stringify(result.payload)) as J;
  } catch (error) {
    if (error instanceof ConsoleApiError) throw new Error(`bases ${method} ${path}: ${error.status} ${JSON.stringify(error.payload)}`);
    throw error;
  }
}

function cliAuth(user: TestUser, scopes = CLI_SCOPES) {
  return {
    user: { id: user.id, primaryEmail: user.email },
    organization: { id: orgId },
    membership: { role: user.orgRole },
    localInstallation: { id: randomUUID() },
    cliSession: { id: randomUUID() },
    accessTokenJti: "synthetic-unprovisioned-session",
    scopes,
  };
}

function kitContext(user: TestUser, scopes = CLI_SCOPES): PageKitCliContext {
  const auth = cliAuth(user, scopes);
  return {
    user: { id: user.id },
    organization: { id: orgId },
    membership: { role: user.orgRole },
    scopes,
    bases: basesCallerFromCliAuth(auth as unknown as Parameters<typeof basesCallerFromCliAuth>[0], randomUUID()),
  };
}

function kitBody(html: string, overrides: Record<string, unknown> = {}) {
  return { project: project.slug, site: site.slug, route: "/", visibility: "private", theme: null, files: [{ path: "index.html", html }], ...overrides };
}

async function kit(user: TestUser, body: unknown, scopes = CLI_SCOPES) {
  try {
    return { status: 200, body: JSON.parse(JSON.stringify(await runPageKitForCli({ context: kitContext(user, scopes), body }))) as J };
  } catch (error) {
    if (error instanceof CliApiError) return { status: error.status, body: { code: error.code, message: error.message } as J };
    throw error;
  }
}

function page(body: string) {
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Pedidos</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function kitOf(html: string): PageKit {
  const match = /<script type="application\/json" id="ravi-kit">([^<]*)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no kit JSON");
  return JSON.parse(match[1]) as PageKit;
}

const errorsOf = (body: J) => (body.diagnostics as J[]).filter((item) => item.severity === "error");

async function publishPage(html: string, presentation: unknown) {
  const auth = cliAuth(owner);
  const context = cliPublishContextFromAuth(auth);
  const bytes = Buffer.from(html, "utf8");
  const packageManifest = {
    entrypoint: "index.html",
    files: [{ path: "index.html", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, contentType: "text/html; charset=utf-8" }],
  };
  const upload = await createPageUploadSession({
    context,
    input: { projectRef: project.slug, siteRef: site.slug, packageManifest },
    requestId: randomUUID(),
  });
  return finalizePageUploadSession({
    context,
    input: {
      uploadSessionId: upload.uploadSession.id,
      idempotencyKey: randomUUID(),
      packageManifest,
      artifact: { slug: `kit-page-${suffix}`, name: "Kit page" },
      publish: { siteRef: site.slug, route: { path: "/", visibility: "private" }, presentation },
    },
    requestId: randomUUID(),
  });
}

describeDb("page kit (db)", () => {
  const views = {} as Record<"list" | "board" | "narrow", string>;
  let widgetItemId = "";
  let previousStorageDriver: string | undefined;

  beforeAll(async () => {
    previousStorageDriver = process.env.RAVI_PAGES_STORAGE_DRIVER;
    process.env.RAVI_PAGES_STORAGE_DRIVER = "metadata";
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `kit-${suffix}`, name: "Page kit test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: project.id, organizationId: orgId, slug: project.slug, name: "Kit" },
      { id: otherProject.id, organizationId: orgId, slug: otherProject.slug, name: "Other" },
    ]);
    await db.insert(schema.pageSites).values([
      { id: site.id, organizationId: orgId, projectId: project.id, slug: site.slug, defaultHostname: site.hostname, isDefault: true },
      { id: otherSite.id, organizationId: orgId, projectId: otherProject.id, slug: otherSite.slug, defaultHostname: otherSite.hostname, isDefault: true },
    ]);

    await library(owner, "POST", "themes", { scope: "org", slug: "clinica", files: themeFiles("Clínica", "#1a1a1a") });
    await library(owner, "POST", "themes", { scope: "org", slug: "noite", files: themeFiles("Noite", "#102030") });
    await library(owner, "POST", "widgets", { scope: "org", slug: "pedido-card", files: widgetFiles() });
    const [item] = await db
      .select({ id: schema.libraryItems.id })
      .from(schema.libraryItems)
      .where(and(eq(schema.libraryItems.organizationId, orgId), eq(schema.libraryItems.slug, "pedido-card")));
    widgetItemId = item?.id ?? "";
    await library(owner, "POST", "themes/active", { scope: "org", ref: "org/clinica" });

    await bases("POST", "", {
      slug: "pedidos",
      name: "Pedidos",
      properties: [
        { key: "pedido", name: "Pedido", type: "text", required: true },
        { key: "fase", name: "Fase", type: "status" },
        { key: "total", name: "Total", type: "number" },
      ],
    });
    views.list = (await bases("POST", "pedidos/views", { name: "Lista", columns: ["pedido", "fase", "total"], layout: { type: "list" } })).id;
    views.board = (
      await bases("POST", "pedidos/views", {
        name: "Quadro",
        columns: ["pedido", "fase", "total"],
        layout: { type: "board", groupBy: "fase", widget: { ref: "org/pedido-card", fields: { titulo: "pedido", valor: "total" } } },
      })
    ).id;
    views.narrow = (await bases("POST", "pedidos/views", { name: "Só números", columns: ["fase", "total"], layout: { type: "list" } })).id;
  });

  afterAll(async () => {
    if (previousStorageDriver === undefined) delete process.env.RAVI_PAGES_STORAGE_DRIVER;
    else process.env.RAVI_PAGES_STORAGE_DRIVER = previousStorageDriver;
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("the theme follows the pointer, an explicit ref, or none", async () => {
    const html = page(`<ravi-view view="${views.list}"></ravi-view>`);
    const pointer = await kit(owner, kitBody(html));
    expect(pointer.status).toBe(200);
    expect(errorsOf(pointer.body)).toEqual([]);
    expect(pointer.body.presentation.theme).toMatchObject({ ref: "org/clinica", version: 1 });
    const pointerHtml = pointer.body.files[0].html as string;
    expect(pointerHtml).toContain(`data-ravi-theme="${pointer.body.presentation.theme.hash}"`);
    expect(kitOf(pointerHtml).theme).toMatchObject({ live: true, ref: { ref: "org/clinica", version: 1 } });
    // Always allowlisted by the exec host: in the page's kit, never in the uses ship declares.
    expect(kitOf(pointerHtml).uses).toContain("ravi.pages.theme.get");
    expect(pointer.body.uses).not.toContain("ravi.pages.theme.get");
    expect(pointer.body.presentation.themeSource).toBe("effective");

    const explicit = await kit(owner, kitBody(html, { theme: "noite" }));
    expect(explicit.body.presentation.theme).toMatchObject({ ref: "org/noite", version: 1 });
    expect(kitOf(explicit.body.files[0].html).theme?.live).toBe(false);
    expect(explicit.body.uses).not.toContain("ravi.pages.theme.get");

    const none = await kit(owner, kitBody(html, { theme: "none" }));
    expect(none.body.presentation.theme).toBeNull();
    expect(none.body.files[0].html).toContain(`data-ravi-theme="${defaultCompiledTheme().hash}"`);

    const missing = await kit(owner, kitBody(html, { theme: "org/sumido" }));
    expect(errorsOf(missing.body).map((item: J) => item.code)).toEqual(["KIT_THEME_NOT_FOUND"]);
    const foreign = await kit(owner, kitBody(html, { theme: `${otherProject.slug}/clinica` }));
    expect(errorsOf(foreign.body).map((item: J) => item.code)).toEqual(["KIT_THEME_OUT_OF_SCOPE"]);
  });

  test("widgets by tag and by the view's layout.widget, with the uses the tags derive", async () => {
    const html = page(
      [
        `<ravi-view view="${views.list}" widget="pedido-card" create></ravi-view>`,
        `<ravi-view view="${views.board}"></ravi-view>`,
        `<ravi-form view="${views.list}" fields="pedido,total"></ravi-form>`,
      ].join("\n"),
    );
    const result = await kit(owner, kitBody(html, { visibility: "public" }));
    expect(result.status).toBe(200);
    expect(errorsOf(result.body)).toEqual([]);
    const shipped = kitOf(result.body.files[0].html);
    expect(shipped.instances.r1).toEqual({ tag: "ravi-view", view: views.list, widget: "org/pedido-card", fields: { titulo: "pedido", status: "fase", valor: "total" }, variant: "default" });
    expect(shipped.instances.r2).toMatchObject({ view: views.board, widget: "org/pedido-card", fields: { titulo: "pedido", status: "fase", valor: "total" } });
    expect(shipped.instances.r3).toEqual({ tag: "ravi-form", view: views.list, widget: null, fields: {}, variant: "default" });
    expect(shipped.widgets["org/pedido-card"]?.ref).toEqual({ itemId: widgetItemId, ref: "org/pedido-card", version: 1 });
    expect(result.body.uses).toEqual([
      "ravi.bases.views.describe",
      "ravi.bases.views.query",
      "ravi.bases.views.rows.create",
      "ravi.bases.views.rows.get",
      "ravi.bases.views.rows.update",
      "ravi.bases.views.version",
    ]);
    expect(shipped.actions).toContainEqual({ id: "ravi.bases.views.rows.create", viewId: views.list });
    expect(shipped.actions).toContainEqual({ id: "ravi.bases.views.rows.update", viewId: views.board });
    expect(shipped.actions).not.toContainEqual({ id: "ravi.bases.views.rows.create", viewId: views.board });
    expect(result.body.presentation.widgets).toEqual([{ itemId: widgetItemId, ref: "org/pedido-card", version: 1 }]);
  });

  test("a chart checks as the shipping user and declares charts.data with its chartId", async () => {
    const chart = await bases("POST", "pedidos/charts", {
      viewId: views.list,
      name: "Total",
      spec: { mark: "text", encoding: { text: { aggregate: "sum", field: "total", type: "quantitative" } } },
    });
    const result = await kit(owner, kitBody(page(`<ravi-chart chart="${chart.id}"></ravi-chart>`)));
    expect(result.status).toBe(200);
    expect(result.body.diagnostics.filter((item: J) => item.code !== "KIT_THEME_DEFAULT")).toEqual([]);
    const shipped = kitOf(result.body.files[0].html);
    expect(shipped.instances.r1).toMatchObject({ tag: "ravi-chart", chart: chart.id });
    expect(shipped.actions).toEqual([{ id: "ravi.bases.charts.data", chartId: chart.id }]);
    expect(result.body.uses).toEqual(["ravi.bases.charts.data"]);

    const unknown = await kit(owner, kitBody(page(`<ravi-chart chart="${randomUUID()}"></ravi-chart>`)));
    expect(errorsOf(unknown.body)).toEqual([]);
    expect(unknown.body.diagnostics.map((item: J) => item.code)).toContain("KIT_CHART_UNAVAILABLE");
  });

  test("a required widget field with no column is an error at the tag", async () => {
    const result = await kit(owner, kitBody(page(`<ravi-view view="${views.narrow}" widget="org/pedido-card"></ravi-view>`)));
    const [error] = errorsOf(result.body);
    expect(error).toMatchObject({ code: "WIDGET_FIELD_MISSING", path: "index.html", line: 8, column: 1 });
    expect(error.message).toContain("titulo");
    expect(error.message).toContain("fase: status");
  });

  test("the caller needs publish authority on the project and a host of that project", async () => {
    const html = page("<p>x</p>");
    expect(await kit(viewer, kitBody(html))).toMatchObject({ status: 403, body: { code: "PUBLISH_NOT_ALLOWED" } });
    expect(await kit(owner, kitBody(html), ["console.projects.read", "artifacts.publish"])).toMatchObject({ status: 403, body: { code: "PUBLISH_NOT_ALLOWED" } });
    expect(await kit(owner, kitBody(html, { site: otherSite.slug }))).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(await kit(owner, kitBody(html, { files: [{ path: "app.js", html }] }))).toMatchObject({ status: 400, body: { code: "PAYLOAD_INVALID" } });
  });

  test("publish stores the presentation; theme and widget updates show in the next kit and in outdated", async () => {
    const html = page(`<ravi-view view="${views.board}"></ravi-view>`);
    const shipped = await kit(owner, kitBody(html));
    expect(errorsOf(shipped.body)).toEqual([]);
    const presentation = shipped.body.presentation;
    const published = await publishPage(shipped.body.files[0].html, presentation);
    const [version] = await db
      .select({ metadataJson: schema.artifactVersions.metadataJson })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.id, published.artifactVersion.id));
    expect((version?.metadataJson as J).presentation).toEqual(presentation);

    const workspace = { user: { id: owner.id }, organization: { id: orgId }, membership: { role: "owner" } };
    expect(await listOutdatedPages({ workspace, projectRef: project.slug })).toEqual({ items: [] });

    await library(owner, "POST", "widgets", { scope: "org", slug: "pedido-card", files: widgetFiles('<ravi-button action="update" set="status=@todo">Reabrir</ravi-button>') });
    const afterWidget = await listOutdatedPages({ workspace, projectRef: project.slug });
    expect(afterWidget.items).toEqual([
      {
        siteSlug: site.slug,
        hostname: site.hostname,
        route: "/",
        releaseId: published.release!.id,
        publishedAt: expect.any(String),
        theme: null,
        widgets: [{ ref: "org/pedido-card", pinned: 1, current: 2 }],
        runtime: { pinned: presentation.runtime.version, current: presentation.runtime.version },
      },
    ]);

    await library(owner, "POST", "themes", { scope: "org", slug: "clinica", files: themeFiles("Clínica", "#202020") });
    const afterTheme = await listOutdatedPages({ workspace, projectRef: project.slug });
    expect(afterTheme.items[0]?.theme).toMatchObject({ pinned: { ref: "org/clinica", version: 1 }, current: { ref: "org/clinica", version: 2 } });
    expect(await listOutdatedPages({ workspace, projectRef: project.slug, runtimeVersion: "1.1.0" })).toMatchObject({
      items: [{ runtime: { pinned: presentation.runtime.version, current: "1.1.0" } }],
    });

    const again = await kit(owner, kitBody(html));
    expect(again.body.warnings).toEqual(["Theme changed since the last publish of /: org/clinica v1 -> v2."]);
    expect(again.body.presentation.widgets).toEqual([{ itemId: widgetItemId, ref: "org/pedido-card", version: 2 }]);

    await expect(listOutdatedPages({ workspace: { ...workspace, user: { id: viewer.id }, membership: { role: "viewer" } }, projectRef: project.slug })).rejects.toMatchObject({
      code: "PROJECT_ACCESS_DENIED",
    });
  });

  test("outdated follows how the ship chose its theme: the pointer, an explicit ref, or none", async () => {
    const workspace = { user: { id: owner.id }, organization: { id: orgId }, membership: { role: "owner" } };
    const outdated = () => listOutdatedPages({ workspace, projectRef: project.slug });
    const html = page(`<ravi-view view="${views.board}"></ravi-view>`);
    const ship = async (theme: string | null) => {
      const shipped = await kit(owner, kitBody(html, { theme }));
      expect(errorsOf(shipped.body)).toEqual([]);
      await publishPage(shipped.body.files[0].html, shipped.body.presentation);
      return shipped.body.presentation;
    };

    // Shipped while no theme applies: behind once one is set.
    await library(owner, "POST", "themes/active", { scope: "org", ref: null });
    expect(await ship(null)).toMatchObject({ theme: null, themeSource: "effective" });
    expect(await outdated()).toEqual({ items: [] });
    await library(owner, "POST", "themes/active", { scope: "org", ref: "org/noite" });
    expect((await outdated()).items).toEqual([
      expect.objectContaining({ route: "/", theme: { pinned: null, current: expect.objectContaining({ ref: "org/noite", version: 1 }) }, widgets: [] }),
    ]);

    // `--theme none` is never behind on its theme.
    expect(await ship("none")).toMatchObject({ theme: null, themeSource: "none" });
    expect(await outdated()).toEqual({ items: [] });

    // An explicit ref follows its own item, not the pointer.
    expect(await ship("org/clinica")).toMatchObject({ theme: { ref: "org/clinica", version: 2 }, themeSource: "explicit" });
    expect(await outdated()).toEqual({ items: [] });
    await library(owner, "POST", "themes", { scope: "org", slug: "clinica", files: themeFiles("Clínica", "#303030") });
    expect((await outdated()).items[0]?.theme).toMatchObject({ pinned: { ref: "org/clinica", version: 2 }, current: { ref: "org/clinica", version: 3 } });
  });

  test("a widget with widget.js ships only after an org admin's audit passes, with the audit link meanwhile", async () => {
    const script = "export function mount(card, ctx) { return {}; }\n";
    const files = [
      { path: "widget.json", content: JSON.stringify({ name: "Vendas", description: "Vendas.", fields: { titulo: { type: "text", required: true } } }) },
      { path: "widget.html", content: '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-canvas label="Vendas"></ravi-canvas></ravi-card>' },
      { path: "widget.js", content: script },
    ];
    await library(owner, "POST", "widgets", { scope: "org", slug: "vendas-js", files });
    const html = page(`<ravi-widget use="vendas-js" data='{"titulo":"Out"}'></ravi-widget>`);
    const run = async () =>
      JSON.parse(JSON.stringify(await runPageKitForCli({ context: kitContext(owner, CLI_SCOPES), body: kitBody(html), origin: "https://console.test" }))) as J;

    const before = await run();
    expect(errorsOf(before)).toEqual([
      expect.objectContaining({ code: "KIT_WIDGET_UNAUDITED", widget: "org/vendas-js@1", url: `https://console.test/${orgId}/library/org/vendas-js?kind=widget` }),
    ]);

    const audited = await routeLibraryRequest({
      workspace: { user: { id: owner.id }, organization: { id: orgId }, membership: { role: owner.orgRole } },
      actor: { surface: "console", requestId: randomUUID(), localInstallationId: null, origin: "https://console.test" },
      method: "POST",
      segments: ["widgets", "org", "vendas-js", "versions", "1", "audit"],
      body: { status: "pass", violations: [], scriptSha256: createHash("sha256").update(script, "utf8").digest("hex") },
      searchParams: new URLSearchParams(),
    });
    expect(audited.status).toBe(200);

    const after = await run();
    expect(errorsOf(after)).toEqual([]);
    expect(after.files[0].html).toContain('<script type="text/plain" id="ravi-widget-js-');
    expect(after.files[0].html).toContain('data-ravi-widget="org/vendas-js@1"');
  });
});
