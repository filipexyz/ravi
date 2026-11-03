import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { basesCallerFromConsoleWorkspace, handleBasesRequest } from "@/server/console/bases";
import { routeLibraryRequest } from "@/server/console/library/cli";
import { db, schema } from "@/server/db";
import { sha256Hex } from "@/shared/widgets/hash";
import { compileWidget } from "@/shared/widgets/template/compile";
import { DEFAULT_THEME_FILES, defaultCompiledTheme } from "@/shared/widgets/theme/default";

import { clearThemeCompileCache, compiledThemeForVersion, pagesThemeForProject } from "./live-theme";

// The theme and widget tools (`themes/default|check`,
// `widgets/catalog|check|preview|scaffold`) through `routeLibraryRequest`, and
// the effective theme behind `ravi.pages.theme.get`. Runs only with
// LIBRARY_TEST_DATABASE_URL (and DATABASE_URL) pointing at a Console database
// with the theme and widget kinds. Creates its own organization, users,
// projects, Library items and base, and deletes them afterwards.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "developer" | "viewer" | "billing" };
type File = { path: string; content: string };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `wtools-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `wtools-b-${suffix}` };

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `widget-tools-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const viewerA = makeUser("viewera", "viewer"); // project viewer of A only
const billing = makeUser("billing", "billing"); // no Library feature
const USERS = [owner, viewerA, billing];

const ROW_SECRET = `SEGREDO-ROW-${suffix}`;

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

function expectStatus(res: Res, status: number, code?: string) {
  if (res.status !== status || (code && res.body?.code !== code)) {
    throw new Error(`expected ${status} ${code ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function bases(method: string, path: string, body: unknown = {}) {
  const caller = basesCallerFromConsoleWorkspace(
    {
      mode: "workos",
      user: { id: owner.id, primaryEmail: owner.email },
      organization: { id: orgId },
      membership: { role: "owner" },
    } as unknown as Parameters<typeof basesCallerFromConsoleWorkspace>[0],
    randomUUID(),
  );
  try {
    const result = await handleBasesRequest({
      caller,
      workspace: null,
      method,
      projectRef: projectA.slug,
      segments: path.split("/").filter(Boolean),
      body,
      searchParams: new URLSearchParams(),
      idempotencyKey: null,
    });
    return JSON.parse(JSON.stringify(result.payload));
  } catch (error) {
    if (error instanceof ConsoleApiError) throw new Error(`bases ${method} ${path}: ${error.status} ${JSON.stringify(error.payload)}`);
    throw error;
  }
}

function themeFiles(input: { name: string; textPrimary: string; locale?: string }): File[] {
  const theme = {
    $description: `Tema ${input.name}.`,
    $extensions: { ravi: { name: input.name, locale: input.locale ?? "pt-BR" } },
    color: { light: { text: { primary: { $type: "color", $value: input.textPrimary } } } },
  };
  return [{ path: "theme.json", content: JSON.stringify(theme, null, 2) }];
}

const MANIFEST = {
  name: "Cartão de pedido",
  description: "Pedido com status e valor.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    status: { type: "status" },
    valor: { type: "number", role: "highlight", label: "Valor" },
  },
  variants: ["default", "compact"],
};

const HTML = [
  '<ravi-variant name="default">',
  "  <ravi-card>",
  "    <ravi-title>{titulo}</ravi-title>",
  '    <ravi-field name="status"></ravi-field>',
  '    <ravi-field name="valor" label="visible"></ravi-field>',
  "  </ravi-card>",
  "</ravi-variant>",
  '<ravi-variant name="compact">',
  '  <ravi-card tone="subtle"><ravi-title size="sm">{titulo}</ravi-title></ravi-card>',
  "</ravi-variant>",
].join("\n");

function widgetFiles(input: { html?: string; manifest?: unknown; example?: unknown; extra?: File[] } = {}): File[] {
  return [
    { path: "widget.html", content: input.html ?? HTML },
    { path: "widget.json", content: JSON.stringify(input.manifest ?? MANIFEST, null, 2) },
    ...(input.example === undefined ? [] : [{ path: "example.json", content: JSON.stringify(input.example) }]),
    ...(input.extra ?? []),
  ];
}

async function publish(kind: "themes" | "widgets", slug: string, files: File[], project?: string) {
  return expectStatus(
    await call(owner, "POST", kind, { body: { scope: project ? "project" : "org", ...(project ? { project } : {}), slug, files } }),
    201,
  );
}

/** Rows the tools must never write: items, versions (also drafts and proposals), files, pointers and audit events of the org. */
async function writeCounts() {
  const count = async (table: Parameters<ReturnType<typeof db.select>["from"]>[0], where: ReturnType<typeof eq>) => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
    return Number(row?.n ?? 0);
  };
  const versionIds = db.select({ id: schema.libraryVersions.id }).from(schema.libraryVersions).where(eq(schema.libraryVersions.organizationId, orgId));
  return {
    items: await count(schema.libraryItems, eq(schema.libraryItems.organizationId, orgId)),
    versions: await count(schema.libraryVersions, eq(schema.libraryVersions.organizationId, orgId)),
    files: await count(schema.libraryFiles, inArray(schema.libraryFiles.versionId, versionIds)),
    pointers: await count(schema.libraryThemePointers, eq(schema.libraryThemePointers.organizationId, orgId)),
    audits: await count(schema.auditEvents, eq(schema.auditEvents.organizationId, orgId)),
  };
}

const hasError = (diagnostics: J[], code: string) => diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.code === code);

describeDb("library widget and theme tools (db)", () => {
  const views = {} as Record<"open" | "hidden", string>;

  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `widget-tools-${suffix}`, name: "Widget tools test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([{ projectId: projectA.id, userId: viewerA.id, role: "viewer" }]);

    await publish("themes", "marca", themeFiles({ name: "Marca", textPrimary: "#123456" }));
    await publish("themes", "marca-en", themeFiles({ name: "Brand", textPrimary: "#234567", locale: "en" }));
    await publish("widgets", "pedido-card", widgetFiles());
    await publish("widgets", "a-card", widgetFiles({ manifest: { ...MANIFEST, name: "Cartão A" } }), projectA.slug);
    await publish("widgets", "b-card", widgetFiles({ manifest: { ...MANIFEST, name: "Cartão B" } }), projectB.slug);
    await publish("widgets", "velho-card", widgetFiles());
    expectStatus(await call(owner, "POST", "widgets/org/velho-card/archive"), 200);

    await bases("POST", "", {
      slug: "orders",
      name: "Orders",
      properties: [
        { key: "name", name: "Cliente", type: "text", required: true },
        { key: "amount", name: "Valor total", type: "number" },
        {
          key: "phase",
          name: "Fase",
          type: "status",
          config: { options: [{ name: "Aberto", group: "todo" }, { name: "Pago", group: "done" }] },
        },
        { key: "cover", name: "Capa", type: "url" },
        { key: "due", name: "Prazo", type: "date" },
      ],
    });
    const columns = ["name", "amount", "phase", "cover", "due", "created_time"];
    views.open = (await bases("POST", "orders/views", { name: "Pedidos abertos", columns, layout: { type: "list" }, access: { read: [{ kind: "user", userId: viewerA.id }] } })).id;
    views.hidden = (await bases("POST", "orders/views", { name: "Oculta", columns, layout: { type: "list" } })).id;
    await bases("POST", "orders/rows", { values: { name: ROW_SECRET, amount: 987654 }, idempotencyKey: `seed-${randomUUID()}` });
  });

  afterAll(async () => {
    clearThemeCompileCache();
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("themes/default answers the built-in theme files", async () => {
    const res = expectStatus(await call(viewerA, "GET", "themes/default"), 200);
    expect(res.files).toEqual(DEFAULT_THEME_FILES.map((file) => ({ path: file.path, content: file.content })));
    expect(res.files.map((file: J) => file.path)).toContain("theme.json");
  });

  test("themes/check reports diagnostics, contrast and css, from the draft when there are errors", async () => {
    const good = expectStatus(await call(viewerA, "POST", "themes/check", { body: { files: DEFAULT_THEME_FILES } }), 200);
    expect(good).toMatchObject({ ok: true, contrast: { ok: true }, css: defaultCompiledTheme().css });
    expect(good.contrast.checks.length).toBeGreaterThan(0);

    const pale = expectStatus(await call(viewerA, "POST", "themes/check", { body: { files: themeFiles({ name: "Pálida", textPrimary: "#f4f4f4" }) } }), 200);
    expect(pale.ok).toBe(false);
    expect(hasError(pale.diagnostics, "THEME_CONTRAST")).toBe(true);
    expect(pale.contrast.ok).toBe(false);
    expect(pale.contrast.checks.some((check: J) => !check.ok && check.pair[0] === "color.light.text.primary")).toBe(true);
    expect(typeof pale.css).toBe("string");
    expect(pale.css).toContain("@layer ravi.theme");

    const missing = expectStatus(await call(viewerA, "POST", "themes/check", { body: { files: [{ path: "fields.json", content: "{}" }] } }), 200);
    expect(missing).toMatchObject({ ok: false, contrast: null, css: null });
    expect(hasError(missing.diagnostics, "THEME_FILE_MISSING")).toBe(true);
  });

  test("check bodies keep publish's file rules and limits", async () => {
    const extra = expectStatus(
      await call(owner, "POST", "themes/check", { body: { files: [...DEFAULT_THEME_FILES, { path: "script.js", content: "x" }] } }),
      200,
    );
    expect(extra.ok).toBe(false);
    expect(extra.diagnostics.find((diagnostic: J) => diagnostic.code === "LIBRARY_FILE_NOT_ALLOWED")).toMatchObject({ severity: "error", file: "script.js" });
    expect(extra.css).toBe(defaultCompiledTheme().css);

    const big = "x".repeat(256 * 1024 + 1);
    expectStatus(await call(owner, "POST", "widgets/check", { body: { files: [{ path: "widget.html", content: big }] } }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "widgets/check", { body: { files: [{ path: "../widget.html", content: "x" }] } }), 400, "PAYLOAD_INVALID");
    expectStatus(
      await call(owner, "POST", "widgets/check", { body: { files: [{ path: "widget.html", content: "a" }, { path: "widget.html", content: "b" }] } }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(await call(owner, "POST", "widgets/check", { body: { files: [], extra: true } }), 400, "PAYLOAD_INVALID");
    // Tool words take one method; the generic routes never see them.
    expectStatus(await call(owner, "GET", "themes/check"), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "widgets/catalog"), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "themes/default"), 404, "NOT_FOUND");
    // A theme slug is still shown by its bare slug.
    expect(expectStatus(await call(owner, "GET", "themes/marca"), 200).item.ref).toBe("org/marca");
  });

  test("widgets/check compiles, and reports template and example errors with positions", async () => {
    const ok = expectStatus(await call(viewerA, "POST", "widgets/check", { body: { files: widgetFiles() } }), 200);
    expect(ok.ok).toBe(true);
    expect(ok.compiled).toMatchObject({ v: 1, name: "Cartão de pedido", fields: { titulo: { type: "text" } } });
    expect(Object.keys(ok.compiled.variants).sort()).toEqual(["compact", "default"]);

    const broken = expectStatus(
      await call(viewerA, "POST", "widgets/check", { body: { files: widgetFiles({ html: HTML.replace('name="valor"', 'name="total"') }) } }),
      200,
    );
    expect(broken).toMatchObject({ ok: false, compiled: null });
    const error = broken.diagnostics.find((diagnostic: J) => diagnostic.severity === "error");
    expect(error).toMatchObject({ code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html" });
    expect(typeof error.line).toBe("number");

    const badExample = expectStatus(
      await call(viewerA, "POST", "widgets/check", { body: { files: widgetFiles({ example: { titulo: "P1", valor: "muito" } }) } }),
      200,
    );
    expect(badExample.ok).toBe(false);
    expect(badExample.diagnostics.find((diagnostic: J) => diagnostic.code === "STATIC_VALUE_INVALID")).toMatchObject({ severity: "error", file: "example.json" });
  });

  test("ravi.pages.theme.get resolves the project's theme, else the org's, cached per version", async () => {
    clearThemeCompileCache();
    expect(await pagesThemeForProject({ organizationId: orgId, projectId: projectA.id })).toEqual({ none: true });

    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "org", ref: "org/marca" } }), 200);
    const org = (await pagesThemeForProject({ organizationId: orgId, projectId: projectA.id })) as J;
    expect(org).toMatchObject({ ref: "org/marca", version: 1, locale: "pt-BR" });
    expect(org.hash).toBe(sha256Hex(org.css));
    expect(org.css).toContain("#123456");
    expect(Object.keys(org).sort()).toEqual(["css", "hash", "locale", "ref", "version"]);

    expectStatus(await call(owner, "POST", "themes/active", { body: { scope: "project", project: projectA.slug, ref: "org/marca-en" } }), 200);
    expect(await pagesThemeForProject({ organizationId: orgId, projectId: projectA.id })).toMatchObject({ ref: "org/marca-en", locale: "en" });
    expect(await pagesThemeForProject({ organizationId: orgId, projectId: projectB.id })).toMatchObject({ ref: "org/marca", hash: org.hash });

    // A new version applies at once; each version compiles once.
    expectStatus(
      await call(owner, "POST", "themes", { body: { scope: "org", slug: "marca", files: themeFiles({ name: "Marca", textPrimary: "#102030" }) } }),
      201,
    );
    const next = (await pagesThemeForProject({ organizationId: orgId, projectId: projectB.id })) as J;
    expect(next).toMatchObject({ ref: "org/marca", version: 2 });
    expect(next.hash).not.toBe(org.hash);
    const files = themeFiles({ name: "Cache", textPrimary: "#123456" });
    expect(compiledThemeForVersion("cache-test", files)).toBe(compiledThemeForVersion("cache-test", files)!);
  });

  test("widgets/catalog lists the published widgets the caller sees, with fields, and the text for agents", async () => {
    const orgOnly = expectStatus(await call(viewerA, "GET", "widgets/catalog"), 200);
    expect(Object.keys(orgOnly).sort()).toEqual(["displays", "fieldTypes", "filters", "pieces", "roles", "text", "tokens", "widgets"]);
    expect(orgOnly.widgets.map((widget: J) => widget.ref)).toEqual(["org/pedido-card"]);
    expect(orgOnly.widgets[0]).toEqual({
      ref: "org/pedido-card",
      name: "Cartão de pedido",
      description: MANIFEST.description,
      fields: {
        titulo: { type: "text", required: true, label: "Pedido" },
        status: { type: "status", required: false, label: "Status" },
        valor: { type: "number", role: "highlight", required: false, label: "Valor" },
      },
      variants: ["default", "compact"],
      script: false,
    });
    expect(orgOnly.text).toContain("org/pedido-card");
    expect(orgOnly.text).not.toContain("velho-card");
    expect(orgOnly.pieces.map((piece: J) => piece.name)).toContain("ravi-card");
    expect(orgOnly.tokens.length).toBeGreaterThan(0);

    const withA = expectStatus(await call(viewerA, "GET", "widgets/catalog", { query: `project=${projectA.slug}` }), 200);
    expect(withA.widgets.map((widget: J) => widget.ref).sort()).toEqual([`${projectA.slug}/a-card`, "org/pedido-card"].sort());
    expect(withA.text).toContain(`${projectA.slug}/a-card`);
    expect(withA.text).not.toContain("b-card");
    expectStatus(await call(viewerA, "GET", "widgets/catalog", { query: `project=${projectB.slug}` }), 403, "PROJECT_ACCESS_DENIED");
    const withB = expectStatus(await call(owner, "GET", "widgets/catalog", { query: `project=${projectB.slug}` }), 200);
    expect(withB.widgets.map((widget: J) => widget.ref)).toContain(`${projectB.slug}/b-card`);
  });

  test("widgets/preview renders every variant in the given, effective or default theme", async () => {
    const preview = async (body: Record<string, unknown>, user: TestUser = viewerA) =>
      expectStatus(await call(user, "POST", "widgets/preview", { body: { files: widgetFiles(), ...body } }), 200);

    const given = await preview({ theme: "org/marca-en", data: { titulo: "Pedido 77", status: "Pago", valor: 10 } });
    expect(given.diagnostics.filter((diagnostic: J) => diagnostic.severity === "error")).toEqual([]);
    expect(given.html.startsWith("<!doctype html>")).toBe(true);
    expect(given.html).toContain('lang="en"');
    expect(given.html).toContain("#234567");
    expect(given.html).toContain("Pedido 77");
    expect(given.html).toContain('data-ravi-mode="light"');
    expect(given.html).toContain('data-ravi-mode="dark"');
    expect(given.html.match(/class="ravi-preview-variant"/g)).toHaveLength(4);
    expect(given.html).not.toMatch(/<script/i);

    // Effective theme: project A's own, else the org's; `default`/`none` is the built-in one.
    const projectTheme = await preview({ project: projectA.slug });
    expect(projectTheme.html).toContain("#234567");
    const orgTheme = await preview({});
    expect(orgTheme.html).toContain('lang="pt-BR"');
    expect(orgTheme.html).toContain("#102030");
    for (const ref of ["default", "none"]) {
      const builtIn = await preview({ theme: ref });
      expect(builtIn.html).toContain(defaultCompiledTheme().css);
      expect(builtIn.html).not.toContain("#102030");
    }
    expectStatus(await call(viewerA, "POST", "widgets/preview", { body: { files: widgetFiles(), theme: "org/nao-existe" } }), 404, "NOT_FOUND");

    // Records: data (one or { records }), else example.json, else invented from the types.
    const many = await preview({ data: { records: [{ titulo: "Primeiro" }, { titulo: "Segundo" }] } });
    expect(many.html).toContain("Primeiro");
    expect(many.html).toContain("Segundo");
    const example = await preview({ files: widgetFiles({ example: { titulo: "Pedido do exemplo", valor: 5 } }) });
    expect(example.html).toContain("Pedido do exemplo");
    const invented = await preview({});
    expect(invented.html).toContain("Pedido de exemplo");
    const wrong = await preview({ data: { titulo: "Pedido X9", valor: "caro" } });
    expect(wrong.diagnostics.find((diagnostic: J) => diagnostic.code === "STATIC_VALUE_INVALID")).toMatchObject({ severity: "error", file: "data" });
    expect(wrong.html).toContain("Pedido X9");

    const broken = await preview({ files: widgetFiles({ html: "<ravi-card><div></div></ravi-card>" }) });
    expect(broken.html).toBeNull();
    expect(broken.diagnostics.some((diagnostic: J) => diagnostic.severity === "error")).toBe(true);
    expectStatus(await call(viewerA, "POST", "widgets/preview", { body: { files: widgetFiles(), project: projectB.slug } }), 403, "PROJECT_ACCESS_DENIED");
  });

  test("widgets/scaffold without a view answers a starter that compiles", async () => {
    const res = expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "meu-cartao" } }), 200);
    expect(res.files.map((file: J) => file.path)).toEqual(["widget.html", "widget.json", "example.json"]);
    expect(compileWidget(res.files).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(JSON.parse(res.files[1].content)).toMatchObject({ name: "Meu cartao", variants: ["default"] });
    expect(res.files[0].content).toContain(">Concluir</ravi-button>");

    expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "Meu Cartão" } }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "catalog" } }), 409, "CONFLICT");
    expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "x", view: "not-a-uuid" } }), 400, "PAYLOAD_INVALID");
  });

  test("widgets/scaffold from a view describes it as the caller: schema only, never rows", async () => {
    const res = expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "pedido-aberto", view: views.open } }), 200);
    expect(res.diagnostics.filter((diagnostic: J) => diagnostic.severity === "error")).toEqual([]);
    expect(compileWidget(res.files).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const manifest = JSON.parse(res.files.find((file: J) => file.path === "widget.json").content);
    expect(manifest.fields).toEqual({
      name: { type: "text", required: true, label: "Cliente" },
      cover: { type: "url", role: "image", label: "Capa" },
      phase: { type: "status", label: "Fase" },
      amount: { type: "number", role: "highlight", label: "Valor total" },
      due: { type: "date", label: "Prazo" },
      created_time: { type: "date", label: "Created time" },
    });
    expect(manifest.description).toContain("Pedidos abertos");
    const html = res.files.find((file: J) => file.path === "widget.html").content;
    expect(html).toContain("<ravi-title>{name}</ravi-title>");
    // Project A uses an English theme, so the scaffold's own text is English.
    expect(html).toContain('<ravi-button action="update" set="phase=@done" variant="primary">Mark as done</ravi-button>');
    const everything = JSON.stringify(res);
    expect(everything).not.toContain(ROW_SECRET);
    expect(everything).not.toContain("987654");

    expect(expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: views.hidden, project: projectA.slug } }), 200).files).toHaveLength(3);
    // A view the caller is not admitted to, a view of another project, and a missing view look the same.
    expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "x", view: views.hidden } }), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: views.open, project: projectB.slug } }), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: randomUUID() } }), 404, "NOT_FOUND");
    expectStatus(await call(viewerA, "POST", "widgets/scaffold", { body: { slug: "x", view: views.open, project: projectB.slug } }), 403, "PROJECT_ACCESS_DENIED");
  });

  test("widgets/scaffold's NOT_FOUND names the project it looked in, and the view's own when the caller can describe it", async () => {
    const wrong = expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: views.open, project: projectB.slug } }), 404, "NOT_FOUND");
    expect(wrong.message).toBe(`View ${views.open} is not in project "${projectB.slug}"; it is in project "${projectA.slug}". Pass --project ${projectA.slug}, or leave --project out.`);
    expect(wrong.details).toEqual({ project: projectB.slug, viewProject: projectA.slug });

    const missing = randomUUID();
    const gone = expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: missing, project: projectB.slug } }), 404, "NOT_FOUND");
    expect(gone.message).toBe(
      `View ${missing} was not found in project "${projectB.slug}", or it does not admit you. --project picks another project; without it the view's own project is used.`,
    );
    expect(gone.details).toEqual({ project: projectB.slug });
    expect(expectStatus(await call(owner, "POST", "widgets/scaffold", { body: { slug: "x", view: missing } }), 404, "NOT_FOUND").message).toBe(
      `View ${missing} was not found, or it does not admit you.`,
    );
  });

  test("every tool needs the Library feature, and none writes", async () => {
    const before = await writeCounts();
    const routes: Array<[string, string, unknown]> = [
      ["GET", "themes/default", {}],
      ["POST", "themes/check", { files: DEFAULT_THEME_FILES }],
      ["GET", "widgets/catalog", {}],
      ["POST", "widgets/check", { files: widgetFiles() }],
      ["POST", "widgets/preview", { files: widgetFiles() }],
      ["POST", "widgets/scaffold", { slug: "x", view: views.open }],
    ];
    for (const [method, path, body] of routes) {
      expectStatus(await call(billing, method, path, { body }), 403, "ORG_ACCESS_DENIED");
      expectStatus(await call(owner, method, path, { body }), 200);
    }
    expect(await writeCounts()).toEqual(before);
    const [item] = await db
      .select({ version: schema.libraryItems.currentVersionNumber })
      .from(schema.libraryItems)
      .where(and(eq(schema.libraryItems.organizationId, orgId), eq(schema.libraryItems.slug, "pedido-card")));
    expect(item?.version).toBe(1);
  });
});
