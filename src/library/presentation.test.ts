import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listCachedVersionDirs } from "./cache.js";
import { openLibrarySession } from "./client.js";
import { diagnosticLine, LibraryDiagnosticsError, normalizeDiagnostics, ThemeCheckFailed } from "./diagnostics.js";
import { libraryKindPath } from "./kinds.js";
import { LibraryPackageError, readPresentationFiles, readPresentationPackage } from "./package.js";
import {
  checkPresentationFolder,
  initTheme,
  initWidget,
  prepareThemeUse,
  previewWidget,
  showPresentationItem,
  themeUseTarget,
  widgetCatalog,
} from "./presentation.js";
import { parseLibraryRef } from "./refs.js";
import {
  executeLibraryProposal,
  executeLibraryPublish,
  listLibraryProposals,
  prepareLibraryProposal,
  prepareLibraryPublish,
  type LibraryServiceDeps,
} from "./service.js";
import {
  createFakeConsole,
  fakeCredentials,
  fakeItem,
  fakeSession,
  json,
  type FakeConsole,
  type FakeConsoleOptions,
} from "./test-fixtures.js";
import type { LibraryKind } from "./kinds.js";

let stateDir: string | null = null;
let workDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-presentation-");
  workDir = mkdtempSync(join(tmpdir(), "ravi-library-presentation-work-"));
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  rmSync(workDir, { recursive: true, force: true });
});

const THEME_JSON = JSON.stringify({
  $description: "Tema da Acme",
  $extensions: { ravi: { name: "Acme" } },
  color: { light: { text: { primary: { $type: "color", $value: "#111111" } } } },
});

const WIDGET_JSON = JSON.stringify({
  name: "Cartão de pedido",
  description: "Pedido com status e valor.",
  fields: { titulo: { type: "text", required: true }, valor: { type: "number", role: "highlight" } },
});

const WIDGET_HTML = '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-field name="valor"></ravi-field></ravi-card>\n';

function themeDir(name = "acme", themeJson = THEME_JSON): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), themeJson);
  writeFileSync(join(dir, "fields.json"), '{ "types": { "date": "relative" } }\n');
  return dir;
}

function widgetDir(name = "pedido-card", widgetJson = WIDGET_JSON): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "widget.html"), WIDGET_HTML);
  writeFileSync(join(dir, "widget.json"), widgetJson);
  return dir;
}

const WARNING = {
  severity: "warning",
  code: "WIDGET_EXAMPLE_PII",
  message: "Looks like a phone.",
  file: "example.json",
};
const ERROR = {
  severity: "error",
  code: "TEMPLATE_UNKNOWN_FIELD",
  message: "Unknown field 'cliente'.",
  file: "widget.html",
  line: 3,
  column: 12,
};

/** A fake Console for one kind, with the check route answering `diagnostics`. */
function presentationConsole(
  kind: LibraryKind,
  items: ReturnType<typeof fakeItem>[] = [],
  options: { diagnostics?: unknown[]; routes?: FakeConsoleOptions["routes"] } = {},
): FakeConsole {
  return createFakeConsole(items, [], {
    kind,
    routes: (request) => {
      const custom = options.routes?.(request);
      if (custom) return custom;
      if (request.method === "POST" && request.rest.join("/") === "check") {
        const diagnostics = options.diagnostics ?? [];
        const ok = !diagnostics.some((entry) => (entry as { severity?: string }).severity === "error");
        return json(
          200,
          kind === "theme"
            ? { ok, diagnostics, contrast: { ok, checks: [] }, css: "@layer ravi.theme{}" }
            : { ok, diagnostics, compiled: ok ? { name: "Cartão", fields: {}, variants: { default: [] } } : null },
        );
      }
      return null;
    },
  });
}

function deps(fake: FakeConsole, project: { slug: string } | null = null): LibraryServiceDeps {
  return {
    openSession: async (options) =>
      fakeSession(fake, options.project ? { slug: options.project } : project, "org-1", options.kind),
    turn: { operatorOwnTurn: true },
  };
}

function requests(fake: FakeConsole): string[] {
  return fake.requests.map((request) => `${request.method} ${request.path}`);
}

describe("kind-aware Library client", () => {
  it("serves every kind under its own segment", async () => {
    expect(libraryKindPath("skill")).toBe("/api/cli/library/skills");
    expect(libraryKindPath("agent")).toBe("/api/cli/library/agents");
    const fake = presentationConsole("widget", [fakeItem({ kind: "widget", slug: "pedido-card", files: [] })]);
    const { ConsoleApiClient } = await import("../cloud-auth/client.js");
    const session = await openLibrarySession(
      { kind: "widget", resolveProject: false },
      {
        readCredentials: () => fakeCredentials(),
        client: new ConsoleApiClient({ consoleUrl: "https://console.test", fetch: fake.fetch }),
      },
    );
    const search = await session!.client.search({ query: "pedido status", limit: 3 });
    await session!.client.showRef(parseLibraryRef("org/pedido-card")!, { version: 1 });
    expect(search.items[0]).toMatchObject({ kind: "widget", slug: "pedido-card" });
    expect(requests(fake)).toEqual([
      "GET /api/cli/library/widgets?q=pedido+status&limit=3",
      "GET /api/cli/library/widgets/org/pedido-card?version=1",
    ]);
  });

  it("refuses a theme route on a widget client", async () => {
    const session = fakeSession(createFakeConsole(), null, "org-1", "widget");
    await expect(session.client.themeDefault()).rejects.toThrow(/widget routes/);
  });

  it("normalizes diagnostics and prints them as file:line:column severity code message", () => {
    const [warning, error, bare] = normalizeDiagnostics([
      WARNING,
      ERROR,
      { severity: "fatal", code: "X", message: "No place." },
      "junk",
    ]);
    expect(diagnosticLine(error!)).toBe("widget.html:3:12 error TEMPLATE_UNKNOWN_FIELD Unknown field 'cliente'.");
    expect(diagnosticLine(warning!)).toBe("example.json warning WIDGET_EXAMPLE_PII Looks like a phone.");
    expect(bare).toMatchObject({ severity: "warning", file: null, line: null });
    expect(diagnosticLine(bare!)).toBe("- warning X No place.");
  });
});

describe("theme and widget folders", () => {
  it("reads only the allowed files and takes name and description from the manifest", () => {
    const dir = themeDir();
    writeFileSync(join(dir, "preview.html"), "<p>x</p>");
    writeFileSync(join(dir, "notes.txt"), "x");
    symlinkSync("/etc/hosts", join(dir, "README.md"));
    expect(() => readPresentationPackage("theme", dir)).toThrow(/regular file/);
    rmSync(join(dir, "README.md"));
    const pkg = readPresentationPackage("theme", dir);
    expect(pkg).toMatchObject({ slug: "acme", name: "Acme", description: "Tema da Acme" });
    expect(pkg.files.map((file) => file.path)).toEqual(["fields.json", "theme.json"]);

    const widget = readPresentationPackage("widget", widgetDir(), { slug: "cartao" });
    expect(widget).toMatchObject({
      slug: "cartao",
      name: "Cartão de pedido",
      description: "Pedido com status e valor.",
    });
  });

  it("refuses missing files, missing descriptions, bad JSON and reserved slugs", () => {
    const noJson = widgetDir("sem-json");
    rmSync(join(noJson, "widget.json"));
    expect(() => readPresentationPackage("widget", noJson)).toThrow(/no widget\.json/);
    expect(readPresentationFiles("widget", noJson).map((file) => file.path)).toEqual(["widget.html"]);
    // widget.js is part of a widget folder; other files (preview.html, chart.js) stay out.
    const withScript = widgetDir("com-codigo");
    writeFileSync(join(withScript, "widget.js"), "export function mount(card, ctx) { return {}; }\n");
    writeFileSync(join(withScript, "preview.html"), "<p>preview</p>");
    writeFileSync(join(withScript, "chart.js"), "export {};\n");
    expect(readPresentationPackage("widget", withScript).files.map((file) => file.path)).toEqual([
      "widget.html",
      "widget.js",
      "widget.json",
    ]);
    expect(() => readPresentationFiles("theme", join(workDir, "nada"))).toThrow(LibraryPackageError);
    const noDescription = themeDir("sem-descricao", JSON.stringify({ color: {} }));
    expect(() => readPresentationPackage("theme", noDescription)).toThrow(/\$description/);
    const broken = themeDir("quebrado", "{ nope");
    expect(() => readPresentationPackage("theme", broken)).toThrow(/ravi themes check/);
    expect(() => readPresentationPackage("theme", themeDir("active"))).toThrow(
      expect.objectContaining({ code: "LIBRARY_SLUG_RESERVED" }),
    );
    expect(() => readPresentationPackage("widget", widgetDir("catalog"))).toThrow(
      expect.objectContaining({ code: "LIBRARY_SLUG_RESERVED" }),
    );
    // `none` is reserved for both kinds; `default` only for themes.
    for (const kind of ["theme", "widget"] as const) {
      const dir = kind === "theme" ? themeDir("none") : widgetDir("none");
      expect(() => readPresentationPackage(kind, dir)).toThrow(
        expect.objectContaining({ code: "LIBRARY_SLUG_RESERVED" }),
      );
    }
    expect(() => readPresentationPackage("theme", themeDir("default"))).toThrow(
      expect.objectContaining({ code: "LIBRARY_SLUG_RESERVED" }),
    );
    expect(readPresentationPackage("widget", widgetDir("default")).slug).toBe("default");
    // Words reserved for skills are fine for widgets.
    expect(readPresentationPackage("widget", widgetDir("pages")).slug).toBe("pages");
  });
});

describe("theme and widget publish", () => {
  it("checks with the Console before the plan and publishes without touching the skill cache", async () => {
    const fake = presentationConsole("widget", [], { diagnostics: [WARNING] });
    const prepared = await prepareLibraryPublish({ kind: "widget", dir: widgetDir(), scope: "org" }, deps(fake));
    expect(prepared.plan).toMatchObject({
      kind: "widget",
      ref: "org/pedido-card",
      name: "Cartão de pedido",
      currentVersion: 0,
      nextVersion: 1,
      warnings: [{ path: ["example.json"], code: "WIDGET_EXAMPLE_PII", severity: "warning" }],
    });
    expect(requests(fake)).toEqual([
      "POST /api/cli/library/widgets/check",
      "GET /api/cli/library/widgets/org/pedido-card",
    ]);
    expect(fake.requests[0]?.body).toEqual({
      files: [
        { path: "widget.html", content: WIDGET_HTML },
        { path: "widget.json", content: WIDGET_JSON },
      ],
    });
    const result = await executeLibraryPublish(prepared, deps(fake));
    expect(result).toMatchObject({ ref: "org/pedido-card", version: { number: 1 }, cacheDir: null });
    expect(result.item.kind).toBe("widget");
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/cli/library/widgets" });
    expect(fake.requests.at(-1)?.body).toMatchObject({
      scope: "org",
      slug: "pedido-card",
      name: "Cartão de pedido",
      description: "Pedido com status e valor.",
      baseVersion: 0,
    });
    expect(listCachedVersionDirs("org-1")).toEqual([]);
  });

  it("stops at the check when it reports errors", async () => {
    const fake = presentationConsole("widget", [], { diagnostics: [ERROR, WARNING] });
    const error = await prepareLibraryPublish({ kind: "widget", dir: widgetDir(), scope: "org" }, deps(fake)).catch(
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(LibraryDiagnosticsError);
    expect((error as LibraryDiagnosticsError).diagnostics).toHaveLength(2);
    expect(requests(fake)).toEqual(["POST /api/cli/library/widgets/check"]);
  });

  it("defaults the scope to the known Console project, and asks for --scope without one", async () => {
    const fake = presentationConsole("theme");
    const prepared = await prepareLibraryPublish({ kind: "theme", dir: themeDir() }, deps(fake, { slug: "clinica" }));
    expect(prepared.plan).toMatchObject({ ref: "clinica/acme", scope: "project", project: "clinica" });
    const missing = await prepareLibraryPublish({ kind: "theme", dir: themeDir() }, deps(fake)).catch((e) => e);
    expect(missing).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });
});

describe("theme and widget proposals", () => {
  it("lets an agent propose in its own project and keeps other projects out of its view", async () => {
    const fake = presentationConsole("widget");
    const caller = { agentId: "autor" };
    const prepared = await prepareLibraryProposal(
      { kind: "widget", dir: widgetDir(), scope: "clinica", caller },
      deps(fake, { slug: "clinica" }),
    );
    expect(prepared.plan).toMatchObject({ kind: "widget", ref: "clinica/pedido-card", agent: "autor", warnings: [] });
    const result = await executeLibraryProposal(prepared);
    expect(result).toMatchObject({ created: true, diagnostics: [] });
    expect(fake.requests.at(-1)).toMatchObject({ path: "/api/cli/library/widgets/proposals" });
    expect(fake.requests.at(-1)?.body).toMatchObject({ agent: { id: "autor" }, submit: true });

    const outside = await prepareLibraryProposal(
      { kind: "widget", dir: widgetDir(), scope: "outro", caller },
      deps(fake, { slug: "clinica" }),
    ).catch((thrown) => thrown);
    expect(outside).toMatchObject({ code: "LIBRARY_OUT_OF_VIEW", exitCode: 3 });

    // The refusal names what the session sees and the --scope that works.
    const named = await prepareLibraryProposal(
      { kind: "widget", dir: widgetDir(), scope: "outro", caller },
      {
        openSession: async (options) => ({
          ...fakeSession(fake, { slug: "painel" }, "org-1", options.kind),
          organization: "acme",
          projectSource: "workspace_default",
        }),
        turn: { operatorOwnTurn: true },
      },
    ).catch((thrown) => thrown);
    expect(named).toMatchObject({
      code: "LIBRARY_OUT_OF_VIEW",
      details: { view: { organization: "acme", project: "painel", source: "workspace_default" } },
    });
    expect(named.message).toContain(
      "This session sees org acme and project painel (from workspace_default); use --scope painel or --scope org.",
    );
    expect(String(named.details.suggestedAction)).toStartWith("Use --scope painel or --scope org, or ask an operator");

    const listed = await listLibraryProposals(
      { kind: "widget", ref: parseLibraryRef("clinica/pedido-card")!, caller },
      { ...deps(fake, { slug: "clinica" }), turn: { operatorOwnTurn: false } },
    );
    // No external-turn rule for widgets: the proposal is listed in a turn that is not the operator's own.
    expect(listed.proposals.map((proposal) => proposal.number)).toEqual([1]);
  });
});

describe("theme and widget reads", () => {
  it("shows a ref or a bare slug, and answers WIDGET_NOT_FOUND", async () => {
    const files = [
      { path: "widget.html", content: WIDGET_HTML },
      { path: "widget.json", content: WIDGET_JSON },
    ];
    const fake = presentationConsole("widget", [
      fakeItem({ kind: "widget", slug: "pedido-card", files, version: 2 }),
      fakeItem({ kind: "widget", slug: "agenda", project: "clinica", files }),
    ]);
    const byRef = await showPresentationItem({ kind: "widget", ref: parseLibraryRef("org/pedido-card")! }, deps(fake));
    expect(byRef).toMatchObject({ ref: { ref: "org/pedido-card" }, version: { number: 2 } });
    const bySlug = await showPresentationItem({ kind: "widget", slug: "agenda" }, deps(fake, { slug: "clinica" }));
    expect(bySlug.ref.ref).toBe("clinica/agenda");
    const missing = await showPresentationItem({ kind: "widget", slug: "nada" }, deps(fake)).catch((e) => e);
    expect(missing).toMatchObject({ code: "WIDGET_NOT_FOUND", exitCode: 1 });
    const outside = await showPresentationItem(
      { kind: "widget", ref: parseLibraryRef("clinica/agenda")!, caller: { agentId: "a" } },
      deps(fake, { slug: "outro" }),
    ).catch((e) => e);
    expect(outside).toMatchObject({ code: "LIBRARY_OUT_OF_VIEW", exitCode: 3 });
  });

  it("reads the widget catalog for the caller's project", async () => {
    const fake = presentationConsole("widget", [], {
      routes: (request) =>
        request.rest[0] === "catalog"
          ? json(200, {
              text: "# Widgets\n",
              pieces: [{ name: "ravi-card" }],
              widgets: [{ ref: "org/pedido-card", name: "Pedido", fields: { valor: { type: "number" } } }],
            })
          : null,
    });
    const catalog = await widgetCatalog({}, deps(fake, { slug: "clinica" }));
    expect(catalog).toEqual({
      project: "clinica",
      text: "# Widgets\n",
      widgets: [
        {
          ref: "org/pedido-card",
          name: "Pedido",
          description: "",
          fields: { valor: { type: "number", role: null, required: false, label: null, description: null } },
          variants: [],
          // An older Console sends no `script`: no widget.js.
          script: false,
        },
      ],
    });
    expect(requests(fake)).toEqual(["GET /api/cli/library/widgets/catalog?project=clinica"]);
  });
});

describe("init, check and preview", () => {
  const defaultTheme = (request: { method: string; rest: string[] }) =>
    request.method === "GET" && request.rest[0] === "default"
      ? json(200, {
          files: [
            { path: "theme.json", content: THEME_JSON },
            { path: "fields.json", content: "{}\n" },
          ],
        })
      : null;

  it("writes the default theme and refuses to overwrite without force", async () => {
    const fake = presentationConsole("theme", [], { routes: defaultTheme });
    const dir = join(workDir, "novo-tema");
    const first = await initTheme({ dir }, deps(fake));
    expect(first.files).toEqual([
      { file: "theme.json", bytes: Buffer.byteLength(THEME_JSON), overwritten: false },
      { file: "fields.json", bytes: 3, overwritten: false },
    ]);
    expect(readFileSync(join(dir, "theme.json"), "utf8")).toBe(THEME_JSON);
    writeFileSync(join(dir, "fields.json"), "mine");
    const refused = await initTheme({ dir }, deps(fake)).catch((e) => e);
    expect(refused).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3 });
    expect(readFileSync(join(dir, "fields.json"), "utf8")).toBe("mine");
    const forced = await initTheme({ dir, force: true }, deps(fake));
    expect(forced.files.every((file) => file.overwritten)).toBe(true);
    expect(readFileSync(join(dir, "fields.json"), "utf8")).toBe("{}\n");
  });

  it("refuses a symlink in place of a file, dangling or not, with or without force", async () => {
    const fake = presentationConsole("theme", [], { routes: defaultTheme });
    const dir = join(workDir, "com-link");
    mkdirSync(dir);
    const outside = join(workDir, "fora.json");
    symlinkSync(outside, join(dir, "theme.json"));
    for (const force of [false, true]) {
      const error = await initTheme({ dir, force }, deps(fake)).catch((e) => e);
      expect(error).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3, details: { existing: ["theme.json"] } });
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(dir, "fields.json"))).toBe(false);

    // A link to a file that exists is refused the same way and the target keeps its bytes.
    const target = join(workDir, "alvo.json");
    writeFileSync(target, "alvo");
    rmSync(join(dir, "theme.json"));
    symlinkSync(target, join(dir, "theme.json"));
    const linked = await initTheme({ dir, force: true }, deps(fake)).catch((e) => e);
    expect(linked).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3 });
    expect(readFileSync(target, "utf8")).toBe("alvo");
  });

  it("never writes a file the kind does not hold", async () => {
    const fake = presentationConsole("theme", [], {
      routes: () => json(200, { files: [{ path: "../escape.json", content: "x" }] }),
    });
    const error = await initTheme({ dir: join(workDir, "t") }, deps(fake)).catch((e) => e);
    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(existsSync(join(workDir, "escape.json"))).toBe(false);
  });

  it("sends the slug, view and project to the widget scaffold", async () => {
    const fake = presentationConsole("widget", [], {
      routes: (request) =>
        request.rest[0] === "scaffold"
          ? json(200, {
              files: [
                { path: "widget.html", content: WIDGET_HTML },
                { path: "widget.json", content: WIDGET_JSON },
                { path: "example.json", content: "{}" },
              ],
              diagnostics: [WARNING],
            })
          : null,
    });
    const view = "0b7c3a52-2f0e-4c1e-9a4b-3f1d2c5e6a7b";
    const outcome = await initWidget(
      { dir: join(workDir, "pedido"), slug: "pedido", view },
      deps(fake, { slug: "clinica" }),
    );
    expect(outcome.files.map((file) => file.file)).toEqual(["widget.html", "widget.json", "example.json"]);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(fake.requests[0]?.body).toEqual({ slug: "pedido", view, project: "clinica" });
  });

  it("names the project a --from-view scaffold used when the view is not found", async () => {
    const fake = presentationConsole("widget", [], {
      routes: (request) =>
        request.rest[0] === "scaffold" ? json(404, { error: { code: "NOT_FOUND", message: "View not found" } }) : null,
    });
    const view = "0b7c3a52-2f0e-4c1e-9a4b-3f1d2c5e6a7b";
    const error = await initWidget(
      { dir: join(workDir, "pedido"), slug: "pedido", view },
      {
        openSession: async (options) => ({
          ...fakeSession(fake, { slug: "page-chat-widget" }, "org-1", options.kind),
          organization: "acme",
          projectSource: "global_default",
        }),
      },
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "NOT_FOUND", exitCode: 1 });
    expect(error.message).toContain(`View ${view} was not found in project page-chat-widget (from global_default)`);
    expect(String(error.details.suggestedAction)).toContain("--project <slug>");
    expect(existsSync(join(workDir, "pedido"))).toBe(false);

    // The Console may name the project it looked in and the view's own project.
    const named = presentationConsole("widget", [], {
      routes: (request) =>
        request.rest[0] === "scaffold"
          ? json(404, {
              error: {
                code: "NOT_FOUND",
                message: "View not found",
                details: { project: "page-chat-widget", viewProject: "painel" },
              },
            })
          : null,
    });
    const located = await initWidget(
      { dir: join(workDir, "pedido"), slug: "pedido", view },
      { openSession: async (options) => fakeSession(named, { slug: "page-chat-widget" }, "org-1", options.kind) },
    ).catch((e) => e);
    expect(located.message).toContain("It belongs to project painel.");
    expect(located.details).toMatchObject({
      viewProject: "painel",
      suggestedAction: "Run the same init with --project painel",
    });
  });

  it("keeps the contrast report on a failed theme check", async () => {
    const contrast = {
      ok: false,
      checks: [
        {
          mode: "light",
          pair: ["color.light.text.secondary", "color.light.background.primary"],
          ratio: 3.9,
          min: 4.5,
          ok: false,
        },
      ],
    };
    const fake = presentationConsole("theme", [], {
      routes: (request) =>
        request.rest[0] === "check"
          ? json(200, {
              ok: false,
              diagnostics: [{ severity: "error", code: "THEME_CONTRAST", message: "Too low.", file: "theme.json" }],
              contrast,
              css: null,
            })
          : null,
    });
    const error = await checkPresentationFolder({ kind: "theme", dir: themeDir() }, deps(fake)).catch((e) => e);
    expect(error).toBeInstanceOf(ThemeCheckFailed);
    expect((error as ThemeCheckFailed).contrast?.checks[0]).toMatchObject({ ratio: 3.9, ok: false });
  });

  it("writes the preview only when it has no errors", async () => {
    let answer: unknown = { html: "<!doctype html><p>ok</p>", diagnostics: [WARNING] };
    const fake = presentationConsole("widget", [], {
      routes: (request) => (request.rest[0] === "preview" ? json(200, answer) : null),
    });
    const dir = widgetDir();
    const out = join(dir, "preview.html");
    const outcome = await previewWidget({ dir, out, theme: "none", data: { valor: 1 } }, deps(fake));
    expect(outcome).toMatchObject({ out, bytes: 24 });
    expect(readFileSync(out, "utf8")).toBe("<!doctype html><p>ok</p>");
    expect(fake.requests[0]?.body).toMatchObject({ theme: "none", data: { valor: 1 } });

    rmSync(out);
    answer = { html: "", diagnostics: [ERROR] };
    const error = await previewWidget({ dir, out }, deps(fake)).catch((e) => e);
    expect(error).toBeInstanceOf(LibraryDiagnosticsError);
    expect(existsSync(out)).toBe(false);
    // A later publish of the folder leaves preview.html out.
    writeFileSync(out, "x");
    expect(readPresentationPackage("widget", dir).files.map((file) => file.path)).toEqual([
      "widget.html",
      "widget.json",
    ]);
  });
});

describe("theme pointers", () => {
  it("targets the org, a --project, or the project of a project theme", () => {
    expect(themeUseTarget({ ref: "org/acme" })).toEqual({ scope: "org", ref: "org/acme" });
    expect(themeUseTarget({ ref: "Acme" })).toEqual({ scope: "org", ref: "acme" });
    expect(themeUseTarget({ ref: "clinica/escuro" })).toEqual({
      scope: "project",
      project: "clinica",
      ref: "clinica/escuro",
    });
    expect(themeUseTarget({ ref: "org/acme", project: "clinica" })).toEqual({
      scope: "project",
      project: "clinica",
      ref: "org/acme",
    });
    expect(themeUseTarget({ ref: "none", project: "clinica" })).toEqual({
      scope: "project",
      project: "clinica",
      ref: null,
    });
    expect(themeUseTarget({ ref: "none" })).toEqual({ scope: "org", ref: null });
    expect(() => themeUseTarget({ ref: "a/b/c" })).toThrow(expect.objectContaining({ code: "LIBRARY_REF_INVALID" }));
  });

  it("plans with dryRun and maps a missing theme to THEME_NOT_FOUND", async () => {
    const fake = presentationConsole("theme", [], {
      routes: (request) => {
        if (request.method !== "POST" || request.rest[0] !== "active") return null;
        const body = request.body as { ref: string | null };
        if (body.ref === "org/nada") return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
        return json(200, {
          plan: {
            scope: "org",
            project: null,
            from: null,
            to: { ref: "org/acme", itemId: "i1", scope: "org", slug: "acme", name: "Acme", setBy: { name: "Op" } },
            affectedHosts: [{ siteSlug: "site", hostname: "acme-site.ravi.page", routes: 2 }],
          },
          applied: false,
        });
      },
    });
    const prepared = await prepareThemeUse({ ref: "org/acme" }, deps(fake));
    expect(prepared.plan.to).toMatchObject({ ref: "org/acme", setBy: "Op", setAt: null });
    expect(prepared.plan.affectedHosts).toEqual([{ siteSlug: "site", hostname: "acme-site.ravi.page", routes: 2 }]);
    expect(fake.requests[0]?.body).toEqual({ scope: "org", ref: "org/acme", dryRun: true });
    const missing = await prepareThemeUse({ ref: "org/nada" }, deps(fake)).catch((e) => e);
    expect(missing).toMatchObject({ code: "THEME_NOT_FOUND", exitCode: 1 });
  });
});
