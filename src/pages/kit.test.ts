import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import {
  applyPageKit,
  collectPageKitFiles,
  describeOutdatedItem,
  formatPageKitDiagnostic,
  listOutdatedPages,
  mergePageUses,
  normalizeShipTheme,
  PAGE_KIT_FILE_MAX_BYTES,
  PAGE_KIT_REQUEST_MAX_BYTES,
  renderOutdatedTable,
  type OutdatedPageItem,
  type PageKitInput,
  type PageKitOutcome,
} from "./kit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ravi-pages-kit-test-"));
  tempDirs.push(dir);
  return dir;
}

type Handler = (method: string, path: string, body: unknown) => Response | Promise<Response>;

/** A real ConsoleApiClient over a fetch mock, so Console error bodies go through the shared mapping. */
function consoleWith(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const client = new ConsoleApiClient({
    consoleUrl: "https://console.example",
    fetch: async (url, init) => {
      const path = url.replace("https://console.example", "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/cli/me")
        return json(200, { user: { email: "alice@example.com" }, organization: { id: "org_1" } });
      calls.push({ method, path, body });
      return handler(method, path, body);
    },
  });
  return { calls, deps: { client, readCredentials: () => credentials() } };
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function credentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "console.projects.link"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}

function kitInput(root: string, overrides: Partial<PageKitInput> = {}): PageKitInput {
  return { root, project: "proj", site: "acme-proj", route: "/", visibility: "private", theme: null, ...overrides };
}

const DIAGNOSTIC = {
  severity: "error",
  code: "WIDGET_UNKNOWN",
  message: "Widget org/missing does not exist.",
  path: "index.html",
  line: 4,
  column: 3,
};

describe("page kit helpers", () => {
  it("normalizes --theme: absent is null, none is none, a ref stays, empty or spaced is refused", () => {
    expect(normalizeShipTheme(undefined)).toBeNull();
    expect(normalizeShipTheme(" None ")).toBe("none");
    expect(normalizeShipTheme(" org/acme ")).toBe("org/acme");
    expect(() => normalizeShipTheme("  ")).toThrow(CloudAuthError);
    expect(() => normalizeShipTheme("org acme")).toThrow(CloudAuthError);
  });

  it("formats diagnostics as path:line:column severity code message", () => {
    expect(formatPageKitDiagnostic({ ...DIAGNOSTIC, severity: "error" })).toBe(
      "index.html:4:3 error WIDGET_UNKNOWN Widget org/missing does not exist.",
    );
    expect(
      formatPageKitDiagnostic({ severity: "warning", code: "X", message: "m", path: null, line: null, column: null }),
    ).toBe("- warning X m");
  });

  it("merges declared and derived uses in order without duplicates", () => {
    expect(
      mergePageUses(
        ["ravi.identity.assertion", "ravi.bases.views.query"],
        ["ravi.bases.views.query", "ravi.bases.views.describe"],
      ),
    ).toEqual(["ravi.identity.assertion", "ravi.bases.views.query", "ravi.bases.views.describe"]);
    expect(mergePageUses(undefined, [])).toBeUndefined();
  });

  it("collects .html and .htm files, skipping other files, dot paths, _ravi and symlinks", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<p>home</p>");
    await writeFile(join(root, "Legacy.HTM"), "<p>legacy</p>");
    await writeFile(join(root, "style.css"), "body{}");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "a.html"), "<p>a</p>");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, ".hidden", "b.html"), "<p>b</p>");
    await mkdir(join(root, "_ravi"));
    await writeFile(join(root, "_ravi", "c.html"), "<p>c</p>");
    await symlink(join(root, "index.html"), join(root, "link.html"));

    const collected = await collectPageKitFiles(root);
    expect(collected).toEqual({
      files: [
        { path: "docs/a.html", html: "<p>a</p>" },
        { path: "index.html", html: "<p>home</p>" },
        { path: "Legacy.HTM", html: "<p>legacy</p>" },
      ],
    });
  });

  it("skips the kit with a warning when one HTML file is over 2 MiB, without calling the Console", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "x".repeat(PAGE_KIT_FILE_MAX_BYTES + 1));
    const { calls, deps } = consoleWith(() => json(500, {}));

    const outcome = await applyPageKit(kitInput(root), deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.kit.status).toBe("skipped");
    expect(outcome.result.kit.warnings[0]).toStartWith("KIT_TOO_LARGE: index.html");
    expect(outcome.result.presentation).toBeNull();
    expect(calls).toEqual([]);
  });

  it("skips the kit with a warning when the request would pass 4 MiB, the Console's limit", async () => {
    expect(PAGE_KIT_REQUEST_MAX_BYTES).toBe(4 * 1024 * 1024);
    const root = await tempRoot();
    // Three files of 1.4 MiB: each under the per-file limit, together over 4 MiB.
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(root, `${name}.html`), "y".repeat(Math.round(1.4 * 1024 * 1024)));
    }
    const { calls, deps } = consoleWith(() => json(500, {}));

    const outcome = await applyPageKit(kitInput(root), deps);
    expect(outcome).toMatchObject({ ok: true, result: { kit: { status: "skipped" }, presentation: null } });
    expect(outcome.ok && outcome.result.kit.warnings[0]).toStartWith(
      "KIT_TOO_LARGE: the HTML files add up to more than 4 MiB",
    );
    expect(calls).toEqual([]);
  });

  it("does not call the Console when there is no HTML file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "data.json"), "{}");
    const { calls, deps } = consoleWith(() => json(500, {}));

    const outcome = await applyPageKit(kitInput(root), deps);
    expect(outcome).toMatchObject({ ok: true, result: { kit: { status: "skipped", warnings: [] }, uses: [] } });
    expect(calls).toEqual([]);
  });
});

describe("applyPageKit against the Console", () => {
  it("posts the request, writes back only changed files it sent, and returns uses and presentation", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-view view='v1'></ravi-view>");
    await writeFile(join(root, "about.html"), "<p>about</p>");
    const presentation = {
      v: 1,
      runtime: { version: "1.0.0", sha256: "abc" },
      theme: null,
      widgets: [{ ref: "org/card", version: 2 }],
    };
    const { calls, deps } = consoleWith(() =>
      json(200, {
        files: [
          {
            path: "index.html",
            html: "<style id='ravi-theme'></style><ravi-view view='v1'></ravi-view>",
            changed: true,
          },
          { path: "about.html", html: "<p>about</p>", changed: false },
          { path: "../escape.html", html: "pwned", changed: true },
        ],
        uses: ["ravi.bases.views.describe", "ravi.bases.views.query", "ravi.bases.views.query"],
        presentation,
        diagnostics: [
          { ...DIAGNOSTIC, severity: "warning", code: "KIT_UNKNOWN_ATTRIBUTE", message: "Unknown attribute foo." },
        ],
        warnings: ["Theme changed since the last publish of /: org/acme v2 -> v3."],
      }),
    );

    const outcome = await applyPageKit(kitInput(root, { theme: "none", route: "/pedidos" }), deps);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/pages/kit",
        body: {
          project: "proj",
          site: "acme-proj",
          route: "/pedidos",
          visibility: "private",
          theme: "none",
          files: [
            { path: "about.html", html: "<p>about</p>" },
            { path: "index.html", html: "<ravi-view view='v1'></ravi-view>" },
          ],
        },
      },
    ]);
    expect(outcome).toEqual({
      ok: true,
      result: {
        kit: {
          status: "applied",
          changedFiles: ["index.html"],
          warnings: [
            "Theme changed since the last publish of /: org/acme v2 -> v3.",
            "index.html:4:3 warning KIT_UNKNOWN_ATTRIBUTE Unknown attribute foo.",
          ],
          theme: null,
          widgets: [{ ref: "org/card", version: 2 }],
        },
        uses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
        presentation,
      },
    });
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(
      "<style id='ravi-theme'></style><ravi-view view='v1'></ravi-view>",
    );
    expect(await readFile(join(root, "about.html"), "utf8")).toBe("<p>about</p>");
    await expect(readFile(join(root, "..", "escape.html"), "utf8")).rejects.toThrow();
  });

  it("reads KIT_INVALID diagnostics from a raw 422 body and from the CLI error envelope", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-widget use='org/missing'></ravi-widget>");

    const raw = consoleWith(() =>
      json(422, { files: [], uses: [], presentation: null, diagnostics: [DIAGNOSTIC], warnings: [] }),
    );
    const envelope = consoleWith(() =>
      json(422, {
        error: {
          code: "KIT_INVALID",
          message: "Page kit found errors.",
          requestId: "req_1",
          details: { diagnostics: [DIAGNOSTIC] },
        },
      }),
    );
    const expected: PageKitOutcome = {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "WIDGET_UNKNOWN",
          message: "Widget org/missing does not exist.",
          path: "index.html",
          line: 4,
          column: 3,
        },
      ],
    };

    expect(await applyPageKit(kitInput(root), raw.deps)).toEqual(expected);
    expect(await applyPageKit(kitInput(root), envelope.deps)).toEqual(expected);
    // `file` (the shared Diagnostic field) is read as the path too.
    const { path: _path, ...withFile } = DIAGNOSTIC;
    const fileShape = consoleWith(() => json(422, { diagnostics: [{ ...withFile, file: "index.html" }] }));
    expect(await applyPageKit(kitInput(root), fileShape.deps)).toEqual(expected);
  });

  it("keeps every non-blocking warning: new codes, object-shaped warnings and info diagnostics", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-widget use='org/card'></ravi-widget>");
    const { deps } = consoleWith(() =>
      json(200, {
        files: [{ path: "index.html", changed: false }],
        uses: [],
        presentation: null,
        diagnostics: [
          { severity: "info", code: "KIT_ACTIONS_NEED_VIEW", message: "org/card has actions; use it in <ravi-view>." },
        ],
        warnings: [
          { code: "KIT_THEME_DEFAULT", message: "No active theme: the page uses Ravi's default theme." },
          { message: "A warning without a code." },
          "Plain text warning.",
          { code: "KIT_NO_MESSAGE" },
        ],
      }),
    );

    const outcome = await applyPageKit(kitInput(root), deps);
    expect(outcome.ok && outcome.result.kit.warnings).toEqual([
      "- warning KIT_THEME_DEFAULT No active theme: the page uses Ravi's default theme.",
      "- warning KIT_WARNING A warning without a code.",
      "Plain text warning.",
      "- warning KIT_NO_MESSAGE (the Console sent no message)",
      "- warning KIT_ACTIONS_NEED_VIEW org/card has actions; use it in <ravi-view>.",
    ]);
  });

  it("keeps the local file when the Console omits html for an unchanged file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-view view='v1'></ravi-view>");
    await writeFile(join(root, "about.html"), "<p>about</p>");
    const { deps } = consoleWith(() =>
      json(200, {
        files: [
          {
            path: "index.html",
            html: "<style id='ravi-theme'></style><ravi-view view='v1'></ravi-view>",
            changed: true,
          },
          { path: "about.html", changed: false },
        ],
        uses: [],
        presentation: null,
        diagnostics: [],
        warnings: [],
      }),
    );

    const outcome = await applyPageKit(kitInput(root), deps);
    expect(outcome).toMatchObject({ ok: true, result: { kit: { status: "applied", changedFiles: ["index.html"] } } });
    expect(await readFile(join(root, "about.html"), "utf8")).toBe("<p>about</p>");
  });

  it("fails rather than ship a file the Console marked changed without its html", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-view view='v1'></ravi-view>");
    const { deps } = consoleWith(() =>
      json(200, { files: [{ path: "index.html", changed: true }], uses: [], presentation: null }),
    );

    await expect(applyPageKit(kitInput(root), deps)).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("<ravi-view view='v1'></ravi-view>");
  });

  it("returns the Console's KIT_TOO_LARGE diagnostic from a 422 KIT_INVALID", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-view view='v1'></ravi-view>");
    const tooLarge = {
      severity: "error" as const,
      code: "KIT_TOO_LARGE",
      message: "The page kit output for index.html is larger than 2 MiB.",
      path: "index.html",
    };
    const { deps } = consoleWith(() =>
      json(422, {
        error: {
          code: "KIT_INVALID",
          message: "Page kit found errors.",
          requestId: "r",
          details: { diagnostics: [tooLarge] },
        },
      }),
    );

    expect(await applyPageKit(kitInput(root), deps)).toEqual({
      ok: false,
      diagnostics: [{ ...tooLarge, line: null, column: null }],
    });
  });

  it("keeps the audit URL and widget of KIT_WIDGET_UNAUDITED, as a diagnostic or as the Console's own code", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<ravi-widget use='org/grafico'></ravi-widget>");
    const url = "https://console.example/library/widgets/org/grafico/versions/2";
    const expected: PageKitOutcome = {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "KIT_WIDGET_UNAUDITED",
          message: "Widget org/grafico@2 has code and no passing accessibility audit.",
          path: "index.html",
          line: 1,
          column: 1,
          url,
          widget: "org/grafico@2",
        },
      ],
    };

    const asDiagnostic = consoleWith(() =>
      json(422, {
        error: {
          code: "KIT_INVALID",
          message: "Page kit found errors.",
          details: {
            diagnostics: [
              {
                severity: "error",
                code: "KIT_WIDGET_UNAUDITED",
                message: "Widget org/grafico@2 has code and no passing accessibility audit.",
                path: "index.html",
                line: 1,
                column: 1,
                auditUrl: url,
                widget: "org/grafico@2",
              },
            ],
          },
        },
      }),
    );
    expect(await applyPageKit(kitInput(root), asDiagnostic.deps)).toEqual(expected);

    const asCode = consoleWith(() =>
      json(409, {
        error: {
          code: "KIT_WIDGET_UNAUDITED",
          message: "Widget org/grafico@2 has code and no passing accessibility audit.",
          details: { url, widget: "org/grafico@2", path: "index.html" },
        },
      }),
    );
    const outcome = await applyPageKit(kitInput(root), asCode.deps);
    expect(outcome).toEqual({
      ok: false,
      diagnostics: [{ ...expected.diagnostics[0]!, line: null, column: null }],
    });
    expect(formatPageKitDiagnostic(outcome.ok ? expected.diagnostics[0]! : outcome.diagnostics[0]!)).toBe(
      `index.html error KIT_WIDGET_UNAUDITED Widget org/grafico@2 has code and no passing accessibility audit. ${url}`,
    );

    // A URL that is not http(s) is dropped, never printed.
    const bad = consoleWith(() =>
      json(422, {
        diagnostics: [{ severity: "error", code: "KIT_WIDGET_UNAUDITED", message: "x", url: "javascript:alert(1)" }],
      }),
    );
    expect(await applyPageKit(kitInput(root), bad.deps)).toEqual({
      ok: false,
      diagnostics: [
        { severity: "error", code: "KIT_WIDGET_UNAUDITED", message: "x", path: null, line: null, column: null },
      ],
    });
  });

  it("treats a bare 404 or 405 as an older Console (KIT_UNAVAILABLE) and leaves the files unchanged", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<p>x</p>");
    for (const response of [
      () => new Response("<!DOCTYPE html><h1>404</h1>", { status: 404, headers: { "Content-Type": "text/html" } }),
      () => new Response("", { status: 405 }),
    ]) {
      const { deps } = consoleWith(response);
      const outcome = await applyPageKit(kitInput(root), deps);
      expect(outcome).toMatchObject({
        ok: true,
        result: { kit: { status: "unavailable", changedFiles: [] }, uses: [], presentation: null },
      });
      expect(outcome.ok && outcome.result.kit.warnings[0]).toStartWith("KIT_UNAVAILABLE:");
    }
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("<p>x</p>");
  });

  it("throws a coded NOT_FOUND, auth and network failures like other Console calls", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "index.html"), "<p>x</p>");

    const notFound = consoleWith(() =>
      json(404, { error: { code: "NOT_FOUND", message: "Theme org/missing was not found.", requestId: "r" } }),
    );
    await expect(applyPageKit(kitInput(root, { theme: "org/missing" }), notFound.deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const forbidden = consoleWith(() =>
      json(403, { error: { code: "PROJECT_ACCESS_DENIED", message: "No.", requestId: "r" } }),
    );
    await expect(applyPageKit(kitInput(root), forbidden.deps)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });

    const offline = consoleWith(() => {
      throw new TypeError("fetch failed");
    });
    const error = await applyPageKit(kitInput(root), offline.deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudAuthError);
    expect(["SERVER_UNAVAILABLE", "HOST_UNREACHABLE"]).toContain((error as CloudAuthError).code);
  });
});

describe("pages outdated", () => {
  const item: OutdatedPageItem = {
    siteSlug: "acme-proj",
    hostname: "acme-proj.ravi.page",
    route: "/pedidos",
    releaseId: "rel_1",
    publishedAt: null,
    theme: {
      pinned: { ref: "org/acme", version: 2, hash: "aaa" },
      current: { ref: "org/acme", version: 3, hash: "bbb" },
    },
    widgets: [{ ref: "org/card", pinned: 1, current: { version: 2 } }],
    runtime: { pinned: "1.0.0", current: "1.1.0" },
  };

  it("describes what is behind on a route", () => {
    expect(describeOutdatedItem(item)).toBe("theme org/acme v2→v3; widget org/card v1→v2; runtime 1.0.0→1.1.0");
    expect(
      describeOutdatedItem({
        ...item,
        theme: { pinned: { ref: "org/old", version: 1 }, current: { ref: "proj/new", version: 4 } },
        widgets: [],
        runtime: { pinned: "1.0.0", current: "1.0.0" },
      }),
    ).toBe("theme org/old v1→proj/new v4");
    expect(
      describeOutdatedItem({
        ...item,
        theme: { pinned: { ref: "org/acme", version: 2 }, current: null },
        widgets: [],
        runtime: null,
      }),
    ).toBe("theme org/acme v2→none");
  });

  it("renders a host, route and behind table", () => {
    expect(renderOutdatedTable([item, { ...item, route: "/", theme: null, widgets: [] }])).toEqual([
      "HOST                 ROUTE     BEHIND",
      "acme-proj.ravi.page  /pedidos  theme org/acme v2→v3; widget org/card v1→v2; runtime 1.0.0→1.1.0",
      "acme-proj.ravi.page  /         runtime 1.0.0→1.1.0",
    ]);
  });

  it("GETs the outdated routes for the project and keeps only known fields", async () => {
    const { calls, deps } = consoleWith(() =>
      json(200, { items: [{ ...item, extra: "dropped" }, { route: null }, "junk"] }),
    );
    const result = await listOutdatedPages({ project: "acme proj" }, deps);

    expect(calls).toEqual([{ method: "GET", path: "/api/cli/pages/outdated?project=acme+proj", body: undefined }]);
    expect(result).toEqual({
      success: true,
      consoleUrl: "https://console.example",
      projectRef: "acme proj",
      total: 1,
      items: [item],
    });
  });
});
